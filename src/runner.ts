import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { PersistentShell } from './shell.js';
import { runJudge } from './judge.js';
import { TestSpecSchema } from './schema.js';
import {
	printBanner,
	printSetup,
	printStep,
	printTeardown,
	printSummary,
	defaultTracePath,
} from './trace.js';
import { resolveConfig } from './config.js';
import type {
	JudgeContext,
	RunOptions,
	StepResult,
	TestSpec,
	TestStep,
	Verdict,
	TraceMeta,
	TraceLifecycle,
	TraceStep,
	TraceSummary,
} from './types.js';

export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

interface ResolvedRetry {
	max: number;
	interval: number;
	backoff: boolean;
}

export function getRetryConfig(step: TestStep): ResolvedRetry | null {
	if (!step.retry) return null;
	const r = typeof step.retry === 'object' ? step.retry : {};
	return {
		max: r.max ?? 3,
		interval: r.interval ?? 10,
		backoff: r.backoff ?? false,
	};
}

export function waitTime(rc: ResolvedRetry | null, attempt: number): number {
	if (!rc) return 0;
	return rc.backoff ? rc.interval * Math.pow(2, attempt) : rc.interval;
}

export async function cmdRun(specPath: string, opts: RunOptions): Promise<void> {
	if (!existsSync(specPath)) {
		console.error(`Test spec not found: ${specPath}`);
		process.exit(1);
	}

	const rawYaml = readFileSync(specPath, 'utf-8');
	const parsed = parse(rawYaml);
	const specResult = TestSpecSchema.safeParse(parsed);
	if (!specResult.success) {
		console.error('Invalid test spec:');
		for (const issue of specResult.error.issues) {
			console.error(`  ${issue.path.join('.')}: ${issue.message}`);
		}
		process.exit(1);
	}
	const testCase = specResult.data as TestSpec;

	if (!testCase.steps || !Array.isArray(testCase.steps)) {
		console.error('Invalid test spec: missing "steps" array');
		process.exit(1);
	}

	const resolved = resolveConfig(opts);
	const apiKey = resolved.api_key.value;
	const baseUrl = resolved.base_url.value;
	const model = resolved.model.value;

	const needsLLM = testCase.steps.some((s) => s.judge?.type === 'llm');
	if (needsLLM && !apiKey) {
		console.error('No API key. Run: atest config set api_key <key>');
		process.exit(1);
	}
	if (needsLLM && !baseUrl) {
		console.error('No base URL. Run: atest config set base_url <url>');
		process.exit(1);
	}
	if (needsLLM && !model) {
		console.error('No model. Run: atest config set model <name>');
		process.exit(1);
	}

	const enableTrace = !opts['no-trace'];
	const tracePath = enableTrace ? (opts.output ?? defaultTracePath(specPath)) : null;
	const traceLines: string[] = [];
	const startedAt = new Date().toISOString();

	const specDir = dirname(specPath);
	const shellCwd = testCase.cwd ? resolve(specDir, testCase.cwd) : process.cwd();

	// Banner
	const metaLine: TraceMeta = {
		type: 'meta',
		name: testCase.name ?? null,
		description: testCase.description ?? null,
		cwd: shellCwd,
		model,
		base_url: baseUrl || null,
		total_steps: testCase.steps.length,
		started_at: startedAt,
		timestamp: startedAt,
	};
	printBanner(metaLine, tracePath);
	if (enableTrace) traceLines.push(JSON.stringify(metaLine));

	// Shell
	const shell = new PersistentShell(shellCwd);

	const stepResults: StepResult[] = [];
	let allPassed = true;
	const overallStart = Date.now();
	const judgeOpts: Omit<JudgeContext, 'stepIndex' | 'retryEnabled'> = {
		apiKey,
		baseUrl,
		model,
		testCase,
		stepResults,
	};

	try {
		// Setup
		if (testCase.setup) {
			for (const cmd of testCase.setup) {
				const result = await shell.exec(cmd, 10000);
				const line: TraceLifecycle = {
					type: 'setup',
					command: cmd,
					stdout: result.stdout,
					stderr: result.stderr,
					exit_code: result.exitCode,
					timestamp: new Date().toISOString(),
				};
				printSetup(line);
				if (enableTrace) traceLines.push(JSON.stringify(line));
			}
		}

		for (let i = 0; i < testCase.steps.length; i++) {
			const step = testCase.steps[i];
			const timeout = (step.timeout ?? 30) * 1000;
			const rc = getRetryConfig(step);
			const retryEnabled = !!rc;

			let attempt = 0;
			let stepDone = false;

			while (!stepDone) {
				const stepStart = Date.now();
				const result = await shell.exec(step.command, timeout);
				const stepDuration = Date.now() - stepStart;
				const stepTimestamp = new Date().toISOString();

				stepResults[i] = { ...result, judgeReason: null, judgeVerdict: null };

				const judgeResult = await runJudge(step, result, {
					...judgeOpts,
					stepIndex: i,
					stepResults,
					retryEnabled,
				});

				stepResults[i].judgeReason = judgeResult.reason;
				stepResults[i].judgeVerdict = judgeResult.verdict;

				// For deterministic judges, convert FAIL → RETRY when retry is available.
				// LLM judges decide RETRY vs FAIL themselves — FAIL is final.
				let verdict = judgeResult.verdict;
				if (verdict === 'FAIL' && rc && attempt < rc.max && judgeResult.type !== 'llm') {
					verdict = 'RETRY';
				}

				// Handle RETRY
				if (verdict === 'RETRY' && rc && attempt < rc.max) {
					const line: TraceStep = {
						type: 'step',
						index: i,
						attempt,
						command: step.command,
						stdout: result.stdout,
						stderr: result.stderr,
						exit_code: result.exitCode,
						timed_out: result.timedOut,
						cwd: result.cwd,
						judge_type: judgeResult.type,
						judge_input: judgeResult.input,
						judge_verdict: 'RETRY',
						judge_reason: judgeResult.reason,
						judge_raw: judgeResult.raw,
						duration_ms: stepDuration,
						timestamp: stepTimestamp,
					};
					printStep(line, testCase.steps.length);
					if (enableTrace) traceLines.push(JSON.stringify(line));

					const wait = waitTime(rc, attempt);
					await sleep(wait * 1000);
					attempt++;
					continue;
				}

				// Final verdict
				const finalVerdict: Verdict = verdict === 'RETRY' ? 'FAIL' : verdict;
				const finalReason =
					verdict === 'RETRY'
						? `max retries (${rc?.max ?? 0}) exceeded: ${judgeResult.reason}`
						: judgeResult.reason;

				stepResults[i].judgeVerdict = finalVerdict;
				stepResults[i].judgeReason = finalReason;
				stepResults[i].attempt = attempt;

				const line: TraceStep = {
					type: 'step',
					index: i,
					attempt,
					command: step.command,
					stdout: result.stdout,
					stderr: result.stderr,
					exit_code: result.exitCode,
					timed_out: result.timedOut,
					cwd: result.cwd,
					judge_type: judgeResult.type,
					judge_input: judgeResult.input,
					judge_verdict: finalVerdict,
					judge_reason: finalReason,
					judge_raw: judgeResult.raw,
					duration_ms: stepDuration,
					timestamp: stepTimestamp,
				};
				printStep(line, testCase.steps.length);
				if (enableTrace) traceLines.push(JSON.stringify(line));

				if (finalVerdict !== 'PASS') {
					allPassed = false;
				}
				stepDone = true;
			}
			if (!allPassed) break;
		}
	} finally {
		// Teardown
		if (testCase.teardown) {
			for (const cmd of testCase.teardown) {
				const result = await shell.exec(cmd, 10000);
				const line: TraceLifecycle = {
					type: 'teardown',
					command: cmd,
					stdout: result.stdout,
					stderr: result.stderr,
					exit_code: result.exitCode,
					timestamp: new Date().toISOString(),
				};
				printTeardown(line);
				if (enableTrace) traceLines.push(JSON.stringify(line));
			}
		}
		shell.close();
	}

	const totalDuration = Date.now() - overallStart;
	const endedAt = new Date().toISOString();

	const totalCount = stepResults.length;
	const passedCount = stepResults.filter((r) => r.judgeVerdict === 'PASS').length;
	const failedCount = stepResults.filter((r) => r.judgeVerdict === 'FAIL').length;
	const retriedCount = stepResults.filter((r) => (r.attempt ?? 0) > 0).length;

	const summaryLine: TraceSummary = {
		type: 'summary',
		total_steps: testCase.steps.length,
		executed_steps: totalCount,
		passed: passedCount,
		failed: failedCount,
		retried: retriedCount,
		result: allPassed ? 'PASS' : 'FAIL',
		duration_ms: totalDuration,
		ended_at: endedAt,
		timestamp: endedAt,
	};
	printSummary(summaryLine, tracePath);

	if (enableTrace) {
		traceLines.push(JSON.stringify(summaryLine));
		writeFileSync(tracePath!, traceLines.join('\n') + '\n');
	}

	process.exit(allPassed ? 0 : 1);
}
