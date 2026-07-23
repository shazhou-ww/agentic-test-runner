#!/usr/bin/env node

/**
 * atest — LLM-judged CLI test runner
 *
 * Subcommands:
 *   atest run <spec.yaml> [options]   Execute spec, judge with LLM, output trace
 *   atest show <trace.jsonl>          Replay trace as human-readable stdout
 *
 * Options (run):
 *   --api-key <key>     LLM API key (or ATEST_API_KEY env)
 *   --base-url <url>    LLM API endpoint (or ATEST_BASE_URL env)
 *   --model <name>      LLM model name (or ATEST_MODEL env, required for LLM judgment)
 *   -o, --output <path>  JSONL trace path (default: <stem>-<timestamp>.jsonl)
 *   --no-trace          Disable trace output
 *
 * Environment:
 *   ATEST_API_KEY       LLM API key
 *   ATEST_BASE_URL      LLM API endpoint
 *   ATEST_MODEL         LLM model name (required for judge type: llm)
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import jsonata from 'jsonata';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));

// ─── Helpers ──────────────────────────────────────────────────────

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// ─── Judge System Prompt ───────────────────────────────────────────

const JUDGE_SYSTEM_PROMPT = `You are a CLI test judge. You are given a sequence of terminal commands and their outputs from a test case. For each step, you receive the command, its output (stdout, stderr, with exit code), and the expected criteria (judge prompt).

Your job: determine if the output meets the expected criteria.

Reply in this exact format:
VERDICT: PASS
REASON: <one sentence explanation>

Or:
VERDICT: FAIL
REASON: <one sentence explanation of what went wrong>

Or (only when the step has retry enabled):
VERDICT: RETRY
REASON: <one sentence explanation of what is still pending>

Be strict but fair. Only PASS when the output clearly meets the criteria. Use RETRY when the output suggests the operation is in progress and might succeed if we wait longer (e.g., service is starting, resource is being created). The exit code is shown as [exit: N] — non-zero exit usually means failure unless the criteria expects it.`;

// ─── Persistent Shell ──────────────────────────────────────────────

class PersistentShell {
	constructor(cwd) {
		this.shell = spawn('bash', ['--noprofile', '--norc', '-s'], {
			cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		this.stdoutBuf = '';
		this.stderrBuf = '';
		this.marker = `__ATEST_MARKER_${Date.now()}_${Math.random().toString(36).slice(2)}__`;

		this.shell.stdout.on('data', (data) => { this.stdoutBuf += data.toString(); });
		this.shell.stderr.on('data', (data) => { this.stderrBuf += data.toString(); });
	}

	async exec(command, timeout = 30000) {
		this.stdoutBuf = '';
		this.stderrBuf = '';
		const startMarker = `${this.marker}START`;
		const endMarker = `${this.marker}END`;
		const exitMarker = `${this.marker}EXIT`;
		const cwdMarker = `${this.marker}CWD`;

		this.shell.stdin.write(`echo "${startMarker}"; ${command}; echo "${exitMarker}$?"; echo "${cwdMarker}$(pwd)"; echo "${endMarker}"\n`);

		const result = await this._waitForMarker(endMarker, timeout);

		const startIdx = result.indexOf(startMarker);
		const exitIdx = result.indexOf(exitMarker);
		if (startIdx === -1 || exitIdx === -1) {
			return { stdout: result, stderr: this.stderrBuf, exitCode: -1, timedOut: true, cwd: null };
		}

		let output = result.slice(startIdx + startMarker.length + 1, exitIdx);
		if (output.startsWith('\n')) output = output.slice(1);

		const exitLine = result.slice(exitIdx + exitMarker.length, result.indexOf(cwdMarker, exitIdx));
		const exitCode = Number.parseInt(exitLine.trim(), 10);

		const cwdStart = result.indexOf(cwdMarker);
		const cwdEnd = result.indexOf(endMarker, cwdStart);
		const cwd = cwdStart !== -1 && cwdEnd !== -1
			? result.slice(cwdStart + cwdMarker.length, cwdEnd).trim()
			: null;

		return {
			stdout: output,
			stderr: this.stderrBuf,
			exitCode: Number.isNaN(exitCode) ? -1 : exitCode,
			timedOut: false,
			cwd,
		};
	}

	_waitForMarker(marker, timeout) {
		return new Promise((resolve) => {
			const startTime = Date.now();
			const check = () => {
				if (this.stdoutBuf.includes(marker)) return resolve(this.stdoutBuf);
				if (Date.now() - startTime > timeout)
					return resolve(this.stdoutBuf + `\n[TIMEOUT after ${timeout}ms]`);
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
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 256 }),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`LLM API error ${response.status}: ${text.slice(0, 200)}`);
	}

	const data = await response.json();
	return data.choices?.[0]?.message?.content ?? '';
}

function parseJudgeResponse(response) {
	const match = response.match(/VERDICT:\s*(PASS|FAIL|RETRY)/i);
	const reasonMatch = response.match(/REASON:\s*(.+)/i);
	const verdict = match ? match[1].toUpperCase() : 'FAIL';
	const reason = reasonMatch ? reasonMatch[1].trim() : response.slice(0, 200);
	return { verdict, reason };
}

// ─── JSONata Judge ─────────────────────────────────────────────────

async function evaluateJsonata(expr, input) {
	const expression = jsonata(expr);
	const result = await expression.evaluate(input);
	return result;
}

// ─── Regex Judge ────────────────────────────────────────────────────

function evaluateRegex(pattern, input) {
	const re = new RegExp(pattern);
	return re.test(input.stdout.trim());
}

// ─── Context Assembly ─────────────────────────────────────────────

function assembleJudgeMessages(testCase, stepResults, currentStepIndex) {
	const step = testCase.steps[currentStepIndex];
	const judge = step.judge;
	const retryEnabled = !!step.retry;

	const messages = [
		{ role: 'system', content: JUDGE_SYSTEM_PROMPT },
		{
			role: 'user',
			content: `Test case: "${testCase.name}"\n${testCase.description ?? ''}\n\nYou previously executed the following commands. Judge the latest step's output against its expected criteria.`,
		},
	];

	for (let i = 0; i <= currentStepIndex; i++) {
		const s = testCase.steps[i];
		const result = stepResults[i];

		messages.push({
			role: 'assistant',
			content: null,
			tool_calls: [{
				id: `call_${i + 1}`,
				type: 'function',
				function: { name: 'terminal', arguments: JSON.stringify({ command: s.command }) },
			}],
		});

		const toolContent = result.stderr
			? `[exit: ${result.exitCode}]\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
			: `[exit: ${result.exitCode}]\n${result.stdout}`;

		messages.push({
			role: 'tool',
			tool_call_id: `call_${i + 1}`,
			content: toolContent,
		});

		if (i < currentStepIndex) {
			messages.push({ role: 'user', content: `Step ${i + 1} 预期: ${s.judge?.prompt ?? '(transition)'}` });
			messages.push({ role: 'assistant', content: `VERDICT: PASS\nREASON: ${result.judgeReason ?? 'Passed'}` });
		} else {
			const instruction = retryEnabled
				? `Step ${i + 1} 预期: ${judge.prompt}\n\n判定 PASS、FAIL 或 RETRY（如操作正在进行中，等待后可能成功），给出原因。`
				: `Step ${i + 1} 预期: ${judge.prompt}\n\n判定 PASS 或 FAIL，给出原因。`;
			messages.push({ role: 'user', content: instruction });
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

// ─── Shared Printers ──────────────────────────────────────────────

function printBanner(meta, tracePath) {
	console.log(`\n🧪 atest — LLM-judged CLI test runner`);
	console.log(`   Case: ${meta.name ?? '(unnamed)'}`);
	console.log(`   Steps: ${meta.total_steps ?? '?'}`);
	console.log(`   Judge: ${meta.model || '(none)'} ${meta.base_url ? '@ ' + meta.base_url : ''}`);
	if (meta.cwd) console.log(`   CWD: ${meta.cwd}`);
	if (tracePath) console.log(`   Trace: ${tracePath}`);
	console.log('');
}

function printSetup(line) {
	console.log(`  [setup] $ ${line.command}`);
}

function printStep(line, totalSteps) {
	const attemptStr = line.attempt > 0 ? ` (retry ${line.attempt})` : '';
	console.log(`\n━━━ Step ${line.index + 1}/${totalSteps}${attemptStr} ━━━`);
	console.log(`  $ ${line.command}`);
	console.log(`  ${truncateOutput(line.stdout)}`);
	if (line.stderr) {
		console.log(`  ${truncateOutput(line.stderr)}`);
	}
	console.log(`  [exit: ${line.exit_code}]`);

	if (line.judge_verdict === 'RETRY') {
		console.log(`  🔄 RETRY: ${line.judge_reason}`);
	} else if (line.judge_verdict === 'PASS') {
		console.log(`  ✅ PASS: ${line.judge_reason}`);
	} else {
		console.log(`  ❌ FAIL: ${line.judge_reason}`);
	}
}

function printTeardown(line) {
	console.log(`  [teardown] $ ${line.command}`);
}

function printSummary(line, tracePath) {
	console.log('\n━━━ Summary ━━━');
	if (line.result === 'PASS') {
		console.log(`✅ All ${line.executed_steps} steps passed!`);
	} else {
		console.log(`❌ ${line.passed}/${line.executed_steps} steps passed`);
	}
	if (line.retried > 0) {
		console.log(`🔄 ${line.retried} step(s) needed retry`);
	}
	if (tracePath) {
		console.log(`📊 Trace: ${tracePath}`);
	}
}

// ─── JSONL Trace Helpers ──────────────────────────────────────────

function timestamp() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, '0');
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function defaultTracePath(specPath) {
	const stem = basename(specPath).replace(/\.ya?ml$/, '');
	return join(process.cwd(), `${stem}-${timestamp()}.jsonl`);
}

// ─── Retry helpers ─────────────────────────────────────────────────

function getRetryConfig(step) {
	if (!step.retry) return null;
	const r = typeof step.retry === 'object' ? step.retry : {};
	return {
		max: r.max ?? 3,
		interval: r.interval ?? 10,
		backoff: r.backoff ?? false,
	};
}

function waitTime(rc, attempt) {
	if (!rc) return 0;
	return rc.backoff ? rc.interval * Math.pow(2, attempt) : rc.interval;
}

// ─── Judge dispatcher ──────────────────────────────────────────────

/**
 * Run the appropriate judge for a step.
 * Returns { verdict, reason, raw }
 * verdict: 'PASS' | 'FAIL' | 'RETRY'
 */
async function runJudge(step, execResult, { apiKey, baseUrl, model, testCase, stepResults, stepIndex, retryEnabled }) {
	const judge = step.judge;

	if (!judge) {
		// Transition step — exit code judge
		const pass = execResult.exitCode === 0;
		return {
			verdict: pass ? 'PASS' : 'FAIL',
			reason: pass ? 'exit code 0 (transition step)' : `exit code ${execResult.exitCode} (transition step, expected 0)`,
			raw: null,
			type: 'exit_code',
			input: null,
		};
	}

	if (judge.type === 'llm') {
		// LLM judge
		const messages = assembleJudgeMessages(testCase, stepResults, stepIndex);
		const judgeResponse = await callJudge({ messages, apiKey, baseUrl, model });
		const { verdict, reason } = parseJudgeResponse(judgeResponse);
		return { verdict, reason, raw: judgeResponse, type: 'llm', input: judge.prompt };
	}

	if (judge.type === 'jsonata') {
		// JSONata judge — deterministic
		const input = { stdout: execResult.stdout, stderr: execResult.stderr, exit_code: execResult.exitCode };
		let result;
		try {
			result = await evaluateJsonata(judge.expr, input);
		} catch (err) {
			return { verdict: 'FAIL', reason: `jsonata error: ${err.message}`, raw: null, type: 'jsonata', input: judge.expr };
		}
		const pass = !!result;
		return {
			verdict: pass ? 'PASS' : 'FAIL',
			reason: pass ? 'jsonata expression matched' : `jsonata expression returned ${JSON.stringify(result)}`,
			raw: null,
			type: 'jsonata',
			input: judge.expr,
		};
	}

	if (judge.type === 'regex') {
		// Regex judge — match against stdout
		const input = { stdout: execResult.stdout, stderr: execResult.stderr, exit_code: execResult.exitCode };
		let pass;
		try {
			pass = evaluateRegex(judge.expr, input);
		} catch (err) {
			return { verdict: 'FAIL', reason: `regex error: ${err.message}`, raw: null, type: 'regex', input: judge.expr };
		}
		return {
			verdict: pass ? 'PASS' : 'FAIL',
			reason: pass ? 'regex matched' : 'regex did not match',
			raw: null,
			type: 'regex',
			input: judge.expr,
		};
	}

	// Unknown judge type
	return { verdict: 'FAIL', reason: `unknown judge type: ${judge.type}`, raw: null, type: 'unknown', input: JSON.stringify(judge) };
}

// ─── cmdRun ───────────────────────────────────────────────────────

async function cmdRun(specPath, opts) {
	if (!existsSync(specPath)) {
		console.error(`Test spec not found: ${specPath}`);
		process.exit(1);
	}

	const rawYaml = readFileSync(specPath, 'utf-8');
	const testCase = parse(rawYaml);

	if (!testCase.steps || !Array.isArray(testCase.steps)) {
		console.error('Invalid test spec: missing "steps" array');
		process.exit(1);
	}

	const apiKey = opts['api-key'] ?? process.env.ATEST_API_KEY ?? '';
	const baseUrl = opts['base-url'] ?? process.env.ATEST_BASE_URL ?? '';
	const model = opts.model ?? process.env.ATEST_MODEL ?? '';

	const needsLLM = testCase.steps.some((s) => s.judge?.type === 'llm');
	if (needsLLM && !apiKey) {
		console.error('No API key. Set ATEST_API_KEY or use --api-key');
		process.exit(1);
	}
	if (needsLLM && !baseUrl) {
		console.error('No base URL. Set ATEST_BASE_URL or use --base-url');
		process.exit(1);
	}
	if (needsLLM && !model) {
		console.error('No model. Set ATEST_MODEL or use --model');
		process.exit(1);
	}

	const enableTrace = !opts['no-trace'];
	const tracePath = enableTrace ? (opts.output ?? defaultTracePath(specPath)) : null;
	const traceLines = [];
	const startedAt = new Date().toISOString();

	const specDir = dirname(specPath);
	const shellCwd = testCase.cwd ? resolve(specDir, testCase.cwd) : process.cwd();

	// Banner
	const metaLine = {
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

	// Setup
	if (testCase.setup) {
		for (const cmd of testCase.setup) {
			const result = await shell.exec(cmd, 10000);
			const line = { type: 'setup', command: cmd, stdout: result.stdout, stderr: result.stderr, exit_code: result.exitCode, timestamp: new Date().toISOString() };
			printSetup(line);
			if (enableTrace) traceLines.push(JSON.stringify(line));
		}
	}

	const stepResults = [];
	let allPassed = true;
	const overallStart = Date.now();
	const judgeOpts = { apiKey, baseUrl, model, testCase, stepResults };

	try {
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

				stepResults[i] = { ...result, judgeReason: null };

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
					const line = {
						type: 'step', index: i, attempt, command: step.command,
						stdout: result.stdout, stderr: result.stderr,
						exit_code: result.exitCode, timed_out: result.timedOut ?? false, cwd: result.cwd,
						judge_type: judgeResult.type, judge_input: judgeResult.input,
						judge_verdict: 'RETRY', judge_reason: judgeResult.reason,
						judge_raw: judgeResult.raw,
						duration_ms: stepDuration, timestamp: stepTimestamp,
					};
					printStep(line, testCase.steps.length);
					if (enableTrace) traceLines.push(JSON.stringify(line));

					const wait = waitTime(rc, attempt);
					await sleep(wait * 1000);
					attempt++;
					continue;
				}

				// Final verdict
				const finalVerdict = verdict === 'RETRY' ? 'FAIL' : verdict;
				const finalReason = verdict === 'RETRY'
					? `max retries (${rc.max}) exceeded: ${judgeResult.reason}`
					: judgeResult.reason;

				stepResults[i].judgeVerdict = finalVerdict;
				stepResults[i].judgeReason = finalReason;
				stepResults[i].attempt = attempt;

				const line = {
					type: 'step', index: i, attempt, command: step.command,
					stdout: result.stdout, stderr: result.stderr,
					exit_code: result.exitCode, timed_out: result.timedOut ?? false, cwd: result.cwd,
					judge_type: judgeResult.type, judge_input: judgeResult.input,
					judge_verdict: finalVerdict, judge_reason: finalReason,
					judge_raw: judgeResult.raw,
					duration_ms: stepDuration, timestamp: stepTimestamp,
				};
				printStep(line, testCase.steps.length);
				if (enableTrace) traceLines.push(JSON.stringify(line));

				if (finalVerdict !== 'PASS') { allPassed = false; }
				stepDone = true;
			}
			if (!allPassed) break;
		}
	} finally {
		if (testCase.teardown) {
			for (const cmd of testCase.teardown) {
				const result = await shell.exec(cmd, 10000);
				const line = { type: 'teardown', command: cmd, stdout: result.stdout, stderr: result.stderr, exit_code: result.exitCode, timestamp: new Date().toISOString() };
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

	const summaryLine = {
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
		writeFileSync(tracePath, traceLines.join('\n') + '\n');
	}

	process.exit(allPassed ? 0 : 1);
}

// ─── cmdShow ──────────────────────────────────────────────────────

async function cmdShow(tracePath) {
	if (!existsSync(tracePath)) {
		console.error(`Trace file not found: ${tracePath}`);
		process.exit(1);
	}

	const raw = readFileSync(tracePath, 'utf-8');
	const lines = raw.trim().split('\n').map((l) => JSON.parse(l));

	let meta = null;
	let totalSteps = 0;

	for (const line of lines) {
		switch (line.type) {
			case 'meta':
				meta = line;
				totalSteps = line.total_steps ?? 0;
				printBanner(line, tracePath);
				break;
			case 'setup':
				printSetup(line);
				break;
			case 'step':
				printStep(line, totalSteps);
				break;
			case 'teardown':
				printTeardown(line);
				break;
			case 'summary':
				printSummary(line, tracePath);
				break;
		}
	}

	process.exit(0);
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
	const args = process.argv.slice(2);
	const subcommand = args[0];
	const rest = args.slice(1);

	if (subcommand === 'run') {
		const { values, positionals } = parseArgs({
			options: {
				'api-key': { type: 'string' },
				'base-url': { type: 'string' },
				model: { type: 'string' },
				output: { type: 'string', short: 'o' },
				'no-trace': { type: 'boolean', default: false },
				help: { type: 'boolean', short: 'h' },
			},
			allowPositionals: true,
			args: rest,
		});

		if (values.help) {
			printRunHelp();
			process.exit(0);
		}
		if (positionals.length === 0) {
			console.error('Usage: atest run <spec.yaml> [options]');
			console.error('Run "atest run --help" for details');
			process.exit(1);
		}

		await cmdRun(positionals[0], values);
	} else if (subcommand === 'show') {
		const { values, positionals } = parseArgs({
			options: {
				help: { type: 'boolean', short: 'h' },
			},
			allowPositionals: true,
			args: rest,
		});

		if (values.help) {
			printShowHelp();
			process.exit(0);
		}
		if (positionals.length === 0) {
			console.error('Usage: atest show <trace.jsonl>');
			process.exit(1);
		}

		await cmdShow(positionals[0]);
	} else if (subcommand === '--version' || subcommand === '-V') {
		console.log(`atest ${pkg.version}`);
		process.exit(0);
	} else if (subcommand === '--help' || subcommand === '-h' || subcommand === undefined) {
		printHelp();
		process.exit(0);
	} else {
		console.error(`Unknown command: ${subcommand}`);
		printHelp();
		process.exit(1);
	}
}

function printHelp() {
	console.log(`atest ${pkg.version} — LLM-judged CLI test runner

Usage:
  atest run <spec.yaml> [options]   Execute spec, judge with LLM
  atest show <trace.jsonl>          Replay trace as human-readable output
  atest -V, --version               Print version
  atest -h, --help                  Show this help

Run "atest run --help" or "atest show --help" for subcommand details.`);
}

function printRunHelp() {
	console.log(`atest run — execute a test spec

Usage: atest run <spec.yaml> [options]

Options:
  --api-key <key>       LLM API key (or ATEST_API_KEY env)
  --base-url <url>      LLM endpoint (or ATEST_BASE_URL env)
  --model <name>        Model name (or ATEST_MODEL env, required for judge type: llm)
  -o, --output <path>   JSONL trace path (default: <stem>-<timestamp>.jsonl)
  --no-trace            Disable trace output
  -h, --help            Show this help

Environment:
  ATEST_API_KEY         LLM API key
  ATEST_BASE_URL        LLM API endpoint
  ATEST_MODEL           LLM model name (required for judge type: llm)

CLI flags override environment variables.`);
}

function printShowHelp() {
	console.log(`atest show — replay a trace as human-readable output

Usage: atest show <trace.jsonl>

Reads a JSONL trace file and prints the same human-readable output
that was shown during "atest run".`);
}

main().catch((err) => {
	console.error('Fatal:', err);
	process.exit(1);
});
