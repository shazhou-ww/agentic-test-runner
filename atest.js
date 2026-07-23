#!/usr/bin/env node

/**
 * atest — LLM-judged CLI test runner
 *
 * Spec: YAML defines TestStep[] = { command, judge_prompt?, timeout? }
 * Execution: run each command in a persistent shell, collect output
 * Judgment:
 *   - If judge_prompt present → LLM judges PASS/FAIL
 *   - If judge_prompt absent → auto-judge by exit code (0=PASS, non-0=FAIL)
 * Trace: JSONL with timestamp on every line
 *
 * Usage:
 *   atest <test-case.yaml> [options]
 *
 * Options:
 *   --api-key <key>     LLM API key (or ATEST_API_KEY env)
 *   --base-url <url>    LLM API endpoint (or ATEST_BASE_URL env)
 *   --model <name>      LLM model name (or ATEST_MODEL env, default: glm-5.2)
 *   -o, --output <path>  JSONL trace output path (default: <stem>-<timestamp>.jsonl)
 *   --no-trace          Disable trace output
 *   --dry-run           Execute commands but skip LLM judgment
 *
 * Environment variables:
 *   ATEST_API_KEY      LLM API key
 *   ATEST_BASE_URL     LLM API endpoint
 *   ATEST_MODEL        LLM model name (default: glm-5.2)
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';

// ─── Judge System Prompt ───────────────────────────────────────────

const JUDGE_SYSTEM_PROMPT = `You are a CLI test judge. You are given a sequence of terminal commands and their outputs from a test case. For each step, you receive the command, its output (with exit code), and the expected criteria (judge prompt).

Your job: determine if the output meets the expected criteria.

Reply in this exact format:
VERDICT: PASS
REASON: <one sentence explanation>

Or:
VERDICT: FAIL
REASON: <one sentence explanation of what went wrong>

Be strict but fair. Only PASS when the output clearly meets the criteria. The exit code is shown as [exit: N] — non-zero exit usually means failure unless the criteria expects it.`;

// ─── Persistent Shell ──────────────────────────────────────────────

class PersistentShell {
	constructor(cwd) {
		this.shell = spawn('bash', ['--noprofile', '--norc', '-s'], {
			cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		this.buffer = '';
		this.marker = `__ATEST_MARKER_${Date.now()}_${Math.random().toString(36).slice(2)}__`;

		this.shell.stdout.on('data', (data) => {
			this.buffer += data.toString();
		});
		this.shell.stderr.on('data', (data) => {
			this.buffer += data.toString();
		});
	}

	async exec(command, timeout = 30000) {
		this.buffer = '';
		const startMarker = `${this.marker}START`;
		const endMarker = `${this.marker}END`;
		const exitMarker = `${this.marker}EXIT`;

		this.shell.stdin.write(`echo "${startMarker}"; ${command}; echo "${exitMarker}$?"; echo "${endMarker}"\n`);

		const result = await this._waitForMarker(endMarker, timeout);

		const startIdx = result.indexOf(startMarker);
		const endIdx = result.indexOf(exitMarker);
		if (startIdx === -1 || endIdx === -1) {
			return { stdout: result, exitCode: -1, timedOut: true };
		}

		let output = result.slice(startIdx + startMarker.length + 1, endIdx);
		if (output.startsWith('\n')) output = output.slice(1);

		const exitLine = result.slice(endIdx + exitMarker.length, result.indexOf(endMarker, endIdx + 1));
		const exitCode = Number.parseInt(exitLine.trim(), 10);

		return { stdout: output, exitCode: Number.isNaN(exitCode) ? -1 : exitCode, timedOut: false };
	}

	_waitForMarker(marker, timeout) {
		return new Promise((resolve) => {
			const startTime = Date.now();
			const check = () => {
				if (this.buffer.includes(marker)) {
					resolve(this.buffer);
					return;
				}
				if (Date.now() - startTime > timeout) {
					resolve(this.buffer + `\n[TIMEOUT after ${timeout}ms]`);
					return;
				}
				setTimeout(check, 50);
			};
			check();
		});
	}

	close() {
		this.shell.stdin.write('exit\n');
		this.shell.kill();
	}
}

// ─── LLM Judge ─────────────────────────────────────────────────────

async function callJudge({ messages, apiKey, baseUrl, model }) {
	const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
	const body = {
		model,
		messages,
		temperature: 0,
		max_tokens: 256,
	};

	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`LLM API error ${response.status}: ${text.slice(0, 200)}`);
	}

	const data = await response.json();
	return data.choices?.[0]?.message?.content ?? '';
}

function parseJudgeResponse(response) {
	const passMatch = response.match(/VERDICT:\s*(PASS|FAIL)/i);
	const reasonMatch = response.match(/REASON:\s*(.+)/i);

	const pass = passMatch ? passMatch[1].toUpperCase() === 'PASS' : false;
	const reason = reasonMatch ? reasonMatch[1].trim() : response.slice(0, 200);

	return { pass, reason };
}

// ─── Context Assembly ─────────────────────────────────────────────

function assembleJudgeMessages(testCase, stepResults, currentStepIndex) {
	const messages = [
		{ role: 'system', content: JUDGE_SYSTEM_PROMPT },
		{
			role: 'user',
			content: `Test case: "${testCase.name}"\n${testCase.description ?? ''}\n\nYou previously executed the following commands. Judge the latest step's output against its expected criteria.`,
		},
	];

	for (let i = 0; i <= currentStepIndex; i++) {
		const step = testCase.steps[i];
		const result = stepResults[i];

		messages.push({
			role: 'assistant',
			content: null,
			tool_calls: [
				{
					id: `call_${i + 1}`,
					type: 'function',
					function: {
						name: 'terminal',
						arguments: JSON.stringify({ command: step.command }),
					},
				},
			],
		});

		const toolContent = `[exit: ${result.exitCode}]\n${result.stdout}`;
		messages.push({
			role: 'tool',
			tool_call_id: `call_${i + 1}`,
			content: toolContent,
		});

		if (i < currentStepIndex) {
			messages.push({
				role: 'user',
				content: `Step ${i + 1} 预期: ${step.judge_prompt}`,
			});
			messages.push({
				role: 'assistant',
				content: `VERDICT: PASS\nREASON: ${result.judgeReason ?? 'Passed'}`,
			});
		} else {
			messages.push({
				role: 'user',
				content: `Step ${i + 1} 预期: ${step.judge_prompt}\n\n判定 PASS 或 FAIL，给出原因。`,
			});
		}
	}

	return messages;
}

// ─── Output Truncation ──────────────────────────────────────────────

function truncateOutput(output, maxLines = 100) {
	const lines = output.split('\n');
	if (lines.length <= maxLines) return output;
	const head = lines.slice(0, 40).join('\n');
	const tail = lines.slice(-40).join('\n');
	return `${head}\n... [truncated ${lines.length - 80} lines] ...\n${tail}`;
}

// ─── JSONL Trace ───────────────────────────────────────────────────

function timestamp() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, '0');
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function defaultTracePath(testCasePath) {
	const stem = basename(testCasePath).replace(/\.ya?ml$/, '');
	return join(process.cwd(), `${stem}-${timestamp()}.jsonl`);
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
	const { values, positionals } = parseArgs({
		options: {
			'api-key': { type: 'string' },
			'base-url': { type: 'string' },
			model: { type: 'string' },
			output: { type: 'string', short: 'o' },
			'no-trace': { type: 'boolean', default: false },
			'dry-run': { type: 'boolean', default: false },
		},
		allowPositionals: true,
	});

	if (positionals.length === 0) {
		console.error('Usage: atest <test-case.yaml> [options]');
		console.error('');
		console.error('Options:');
		console.error('  --api-key <key>       LLM API key (or ATEST_API_KEY env)');
		console.error('  --base-url <url>      LLM endpoint (or ATEST_BASE_URL env)');
		console.error('  --model <name>        Model name (or ATEST_MODEL env, default: glm-5.2)');
		console.error('  -o, --output <path>   JSONL trace path (default: <stem>-<timestamp>.jsonl)');
		console.error('  --no-trace            Disable trace output');
		console.error('  --dry-run             Execute commands, skip LLM judgment');
		console.error('');
		console.error('Environment:');
		console.error('  ATEST_API_KEY         LLM API key');
		console.error('  ATEST_BASE_URL        LLM API endpoint');
		console.error('  ATEST_MODEL           LLM model name (default: glm-5.2)');
		process.exit(1);
	}

	const testCasePath = positionals[0];
	if (!existsSync(testCasePath)) {
		console.error(`Test case not found: ${testCasePath}`);
		process.exit(1);
	}

	// Parse YAML
	const rawYaml = readFileSync(testCasePath, 'utf-8');
	const testCase = parse(rawYaml);

	// Validate
	if (!testCase.steps || !Array.isArray(testCase.steps)) {
		console.error('Invalid test case: missing "steps" array');
		process.exit(1);
	}

	// Resolve LLM config: CLI > env > default
	const apiKey = values['api-key'] ?? process.env.ATEST_API_KEY ?? '';
	const baseUrl = values['base-url'] ?? process.env.ATEST_BASE_URL ?? '';
	const model = values.model ?? process.env.ATEST_MODEL ?? 'glm-5.2';

	// Check if LLM is needed (any step with judge_prompt and not dry-run)
	const needsLLM = !values['dry-run'] && testCase.steps.some((s) => s.judge_prompt);
	if (needsLLM && !apiKey) {
		console.error('No API key. Set ATEST_API_KEY or use --api-key');
		process.exit(1);
	}

	// Trace config
	const enableTrace = !values['no-trace'];
	const tracePath = enableTrace ? (values.output ?? defaultTracePath(testCasePath)) : null;
	const traceLines = [];

	const startedAt = new Date().toISOString();

	// stdout: brief banner
	console.log(`\n🧪 atest — LLM-judged CLI test runner`);
	console.log(`   Case: ${testCase.name ?? testCasePath}`);
	console.log(`   Steps: ${testCase.steps.length}`);
	console.log(`   Judge: ${model} @ ${baseUrl || '(dry-run)'}`);
	if (tracePath) {
		console.log(`   Trace: ${tracePath}`);
	}
	console.log('');

	// Trace: meta (verbose)
	if (enableTrace) {
		traceLines.push(JSON.stringify({
			type: 'meta',
			name: testCase.name ?? null,
			description: testCase.description ?? null,
			model,
			base_url: baseUrl || null,
			total_steps: testCase.steps.length,
			started_at: startedAt,
			timestamp: startedAt,
		}));
	}

	// Setup persistent shell — always cwd of where atest is run
	const shell = new PersistentShell(process.cwd());

	// Run setup commands
	if (testCase.setup) {
		for (const cmd of testCase.setup) {
			console.log(`  [setup] $ ${cmd}`);
			const setupResult = await shell.exec(cmd, 10000);
			if (enableTrace) {
				traceLines.push(JSON.stringify({
					type: 'setup',
					command: cmd,
					stdout: setupResult.stdout,
					exit_code: setupResult.exitCode,
					timestamp: new Date().toISOString(),
				}));
			}
		}
	}

	const stepResults = [];
	let allPassed = true;
	const overallStart = Date.now();

	try {
		for (let i = 0; i < testCase.steps.length; i++) {
			const step = testCase.steps[i];
			const timeout = (step.timeout ?? 30) * 1000;
			const stepStart = Date.now();

			// stdout: brief
			console.log(`\n━━━ Step ${i + 1}/${testCase.steps.length} ━━━`);
			console.log(`  $ ${step.command}`);

			// Execute command
			const result = await shell.exec(step.command, timeout);
			const truncated = truncateOutput(result.stdout);
			console.log(`  ${truncated}`);
			console.log(`  [exit: ${result.exitCode}]`);
			const stepDuration = Date.now() - stepStart;
			const stepTimestamp = new Date().toISOString();

			if (values['dry-run']) {
				console.log(`  ⏭️  dry-run, skipping judgment`);
				stepResults.push({ ...result, judgeReason: 'dry-run', judgeVerdict: 'SKIP' });

				if (enableTrace) {
					traceLines.push(JSON.stringify({
						type: 'step',
						index: i,
						command: step.command,
						stdout: result.stdout,
						exit_code: result.exitCode,
						timed_out: result.timedOut ?? false,
						judge_prompt: step.judge_prompt ?? null,
						judge_verdict: 'SKIP',
						judge_reason: 'dry-run',
						judge_raw: null,
						judge_method: null,
						duration_ms: stepDuration,
						timestamp: stepTimestamp,
					}));
				}
				continue;
			}

			// Push current result before assembly (filled after)
			stepResults.push({ ...result, judgeReason: null });

			// Determine judgment method
			if (step.judge_prompt) {
				// LLM judgment
				const messages = assembleJudgeMessages(testCase, stepResults, i);
				const judgeResponse = await callJudge({ messages, apiKey, baseUrl, model });
				const { pass, reason } = parseJudgeResponse(judgeResponse);

				stepResults[i].judgeReason = reason;
				stepResults[i].judgeVerdict = pass ? 'PASS' : 'FAIL';

				if (enableTrace) {
					traceLines.push(JSON.stringify({
						type: 'step',
						index: i,
						command: step.command,
						stdout: result.stdout,
						exit_code: result.exitCode,
						timed_out: result.timedOut ?? false,
						judge_prompt: step.judge_prompt,
						judge_verdict: pass ? 'PASS' : 'FAIL',
						judge_reason: reason,
						judge_raw: judgeResponse,
						judge_method: 'llm',
						duration_ms: stepDuration,
						timestamp: stepTimestamp,
					}));
				}

				if (pass) {
					console.log(`  ✅ PASS: ${reason}`);
				} else {
					console.log(`  ❌ FAIL: ${reason}`);
					allPassed = false;
					break;
				}
			} else {
				// Transition step — auto-judge by exit code
				const pass = result.exitCode === 0;
				const reason = pass
					? `exit code 0 (transition step)`
					: `exit code ${result.exitCode} (transition step, expected 0)`;

				stepResults[i].judgeReason = reason;
				stepResults[i].judgeVerdict = pass ? 'PASS' : 'FAIL';

				if (enableTrace) {
					traceLines.push(JSON.stringify({
						type: 'step',
						index: i,
						command: step.command,
						stdout: result.stdout,
						exit_code: result.exitCode,
						timed_out: result.timedOut ?? false,
						judge_prompt: null,
						judge_verdict: pass ? 'PASS' : 'FAIL',
						judge_reason: reason,
						judge_raw: null,
						judge_method: 'exit_code',
						duration_ms: stepDuration,
						timestamp: stepTimestamp,
					}));
				}

				if (pass) {
					console.log(`  ✅ PASS: ${reason}`);
				} else {
					console.log(`  ❌ FAIL: ${reason}`);
					allPassed = false;
					break;
				}
			}
		}
	} finally {
		// Run teardown commands
		if (testCase.teardown) {
			for (const cmd of testCase.teardown) {
				console.log(`  [teardown] $ ${cmd}`);
				const teardownResult = await shell.exec(cmd, 10000);
				if (enableTrace) {
					traceLines.push(JSON.stringify({
						type: 'teardown',
						command: cmd,
						stdout: teardownResult.stdout,
						exit_code: teardownResult.exitCode,
						timestamp: new Date().toISOString(),
					}));
				}
			}
		}
		shell.close();
	}

	const totalDuration = Date.now() - overallStart;
	const endedAt = new Date().toISOString();

	// stdout: brief summary
	console.log('\n━━━ Summary ━━━');
	const totalCount = stepResults.length;
	const passedCount = stepResults.filter((r) => r.judgeVerdict === 'PASS').length;
	const failedCount = stepResults.filter((r) => r.judgeVerdict === 'FAIL').length;
	const skippedCount = stepResults.filter((r) => r.judgeVerdict === 'SKIP').length;

	if (allPassed) {
		console.log(`✅ All ${totalCount} steps passed!`);
	} else {
		console.log(`❌ ${passedCount}/${totalCount} steps passed`);
	}

	// Trace: summary (verbose)
	if (enableTrace) {
		traceLines.push(JSON.stringify({
			type: 'summary',
			total_steps: testCase.steps.length,
			executed_steps: totalCount,
			passed: passedCount,
			failed: failedCount,
			skipped: skippedCount,
			result: allPassed ? 'PASS' : 'FAIL',
			duration_ms: totalDuration,
			ended_at: endedAt,
			timestamp: endedAt,
		}));

		writeFileSync(tracePath, traceLines.join('\n') + '\n');
		console.log(`📊 Trace: ${tracePath}`);
	}

	process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
	console.error('Fatal:', err);
	process.exit(1);
});
