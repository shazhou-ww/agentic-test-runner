#!/usr/bin/env node

/**
 * atest — LLM-judged CLI test runner
 *
 * Subcommands:
 *   atest run <spec.yaml> [options]   Execute spec, judge with LLM, output trace
 *   atest show <trace.jsonl>          Replay trace as human-readable stdout
 *
 * Shorthand: atest <spec.yaml> = atest run <spec.yaml>
 *
 * Options (run):
 *   --api-key <key>     LLM API key (or ATEST_API_KEY env)
 *   --base-url <url>    LLM API endpoint (or ATEST_BASE_URL env)
 *   --model <name>      LLM model name (or ATEST_MODEL env, required for LLM judgment)
 *   -o, --output <path>  JSONL trace path (default: <stem>-<timestamp>.jsonl)
 *   --no-trace          Disable trace output
 *   --dry-run           Execute commands but skip LLM judgment
 *
 * Environment:
 *   ATEST_API_KEY       LLM API key
 *   ATEST_BASE_URL      LLM API endpoint
 *   ATEST_MODEL         LLM model name (required for LLM judgment)
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));

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

		this.shell.stdout.on('data', (data) => { this.buffer += data.toString(); });
		this.shell.stderr.on('data', (data) => { this.buffer += data.toString(); });
	}

	async exec(command, timeout = 30000) {
		this.buffer = '';
		const startMarker = `${this.marker}START`;
		const endMarker = `${this.marker}END`;
		const exitMarker = `${this.marker}EXIT`;
		const cwdMarker = `${this.marker}CWD`;

		this.shell.stdin.write(`echo "${startMarker}"; ${command}; echo "${exitMarker}$?"; echo "${cwdMarker}$(pwd)"; echo "${endMarker}"\n`);

		const result = await this._waitForMarker(endMarker, timeout);

		const startIdx = result.indexOf(startMarker);
		const exitIdx = result.indexOf(exitMarker);
		if (startIdx === -1 || exitIdx === -1) {
			return { stdout: result, exitCode: -1, timedOut: true, cwd: null };
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
			exitCode: Number.isNaN(exitCode) ? -1 : exitCode,
			timedOut: false,
			cwd,
		};
	}

	_waitForMarker(marker, timeout) {
		return new Promise((resolve) => {
			const startTime = Date.now();
			const check = () => {
				if (this.buffer.includes(marker)) return resolve(this.buffer);
				if (Date.now() - startTime > timeout)
					return resolve(this.buffer + `\n[TIMEOUT after ${timeout}ms]`);
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
			tool_calls: [{
				id: `call_${i + 1}`,
				type: 'function',
				function: { name: 'terminal', arguments: JSON.stringify({ command: step.command }) },
			}],
		});

		messages.push({
			role: 'tool',
			tool_call_id: `call_${i + 1}`,
			content: `[exit: ${result.exitCode}]\n${result.stdout}`,
		});

		if (i < currentStepIndex) {
			messages.push({ role: 'user', content: `Step ${i + 1} 预期: ${step.judge_prompt}` });
			messages.push({ role: 'assistant', content: `VERDICT: PASS\nREASON: ${result.judgeReason ?? 'Passed'}` });
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

// ─── Shared Printers ──────────────────────────────────────────────

function printBanner(meta, tracePath) {
	console.log(`\n🧪 atest — LLM-judged CLI test runner`);
	console.log(`   Case: ${meta.name ?? '(unnamed)'}`);
	console.log(`   Steps: ${meta.total_steps ?? '?'}`);
	console.log(`   Judge: ${meta.model ?? '?'} @ ${meta.base_url || '(dry-run)'}`);
	if (meta.cwd) console.log(`   CWD: ${meta.cwd}`);
	if (tracePath) console.log(`   Trace: ${tracePath}`);
	console.log('');
}

function printSetup(line) {
	console.log(`  [setup] $ ${line.command}`);
}

function printStep(line, totalSteps) {
	console.log(`\n━━━ Step ${line.index + 1}/${totalSteps} ━━━`);
	console.log(`  $ ${line.command}`);
	console.log(`  ${truncateOutput(line.stdout)}`);
	console.log(`  [exit: ${line.exit_code}]`);

	if (line.judge_verdict === 'SKIP') {
		console.log(`  ⏭️  dry-run, skipping judgment`);
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

	const needsLLM = !opts['dry-run'] && testCase.steps.some((s) => s.judge_prompt);
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
			const line = { type: 'setup', command: cmd, stdout: result.stdout, exit_code: result.exitCode, timestamp: new Date().toISOString() };
			printSetup(line);
			if (enableTrace) traceLines.push(JSON.stringify(line));
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

			const result = await shell.exec(step.command, timeout);
			const stepDuration = Date.now() - stepStart;
			const stepTimestamp = new Date().toISOString();

			if (opts['dry-run']) {
				const line = {
					type: 'step', index: i, command: step.command, stdout: result.stdout,
					exit_code: result.exitCode, timed_out: result.timedOut ?? false, cwd: result.cwd,
					judge_prompt: step.judge_prompt ?? null, judge_verdict: 'SKIP',
					judge_reason: 'dry-run', judge_raw: null, judge_method: null,
					duration_ms: stepDuration, timestamp: stepTimestamp,
				};
				printStep(line, testCase.steps.length);
				if (enableTrace) traceLines.push(JSON.stringify(line));
				stepResults.push({ ...result, judgeReason: 'dry-run', judgeVerdict: 'SKIP' });
				continue;
			}

			stepResults.push({ ...result, judgeReason: null });

			if (step.judge_prompt) {
				// LLM judgment
				const messages = assembleJudgeMessages(testCase, stepResults, i);
				const judgeResponse = await callJudge({ messages, apiKey, baseUrl, model });
				const { pass, reason } = parseJudgeResponse(judgeResponse);

				stepResults[i].judgeReason = reason;
				stepResults[i].judgeVerdict = pass ? 'PASS' : 'FAIL';

				const line = {
					type: 'step', index: i, command: step.command, stdout: result.stdout,
					exit_code: result.exitCode, timed_out: result.timedOut ?? false, cwd: result.cwd,
					judge_prompt: step.judge_prompt, judge_verdict: pass ? 'PASS' : 'FAIL',
					judge_reason: reason, judge_raw: judgeResponse, judge_method: 'llm',
					duration_ms: stepDuration, timestamp: stepTimestamp,
				};
				printStep(line, testCase.steps.length);
				if (enableTrace) traceLines.push(JSON.stringify(line));

				if (!pass) { allPassed = false; break; }
			} else {
				// Transition step — auto-judge by exit code
				const pass = result.exitCode === 0;
				const reason = pass
					? `exit code 0 (transition step)`
					: `exit code ${result.exitCode} (transition step, expected 0)`;

				stepResults[i].judgeReason = reason;
				stepResults[i].judgeVerdict = pass ? 'PASS' : 'FAIL';

				const line = {
					type: 'step', index: i, command: step.command, stdout: result.stdout,
					exit_code: result.exitCode, timed_out: result.timedOut ?? false, cwd: result.cwd,
					judge_prompt: null, judge_verdict: pass ? 'PASS' : 'FAIL',
					judge_reason: reason, judge_raw: null, judge_method: 'exit_code',
					duration_ms: stepDuration, timestamp: stepTimestamp,
				};
				printStep(line, testCase.steps.length);
				if (enableTrace) traceLines.push(JSON.stringify(line));

				if (!pass) { allPassed = false; break; }
			}
		}
	} finally {
		if (testCase.teardown) {
			for (const cmd of testCase.teardown) {
				const result = await shell.exec(cmd, 10000);
				const line = { type: 'teardown', command: cmd, stdout: result.stdout, exit_code: result.exitCode, timestamp: new Date().toISOString() };
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
	const skippedCount = stepResults.filter((r) => r.judgeVerdict === 'SKIP').length;

	const summaryLine = {
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

	// Subcommand detection
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
				'dry-run': { type: 'boolean', default: false },
			},
			allowPositionals: true,
			args: rest,
		});

		if (positionals.length === 0) {
			console.error('Usage: atest run <spec.yaml> [options]');
			process.exit(1);
		}

		await cmdRun(positionals[0], values);
	} else if (subcommand === 'show') {
		const { positionals } = parseArgs({
			allowPositionals: true,
			args: rest,
		});

		if (positionals.length === 0) {
			console.error('Usage: atest show <trace.jsonl>');
			process.exit(1);
		}

		await cmdShow(positionals[0]);
	} else if (subcommand === '--version' || subcommand === '-V') {
		console.log(`atest ${pkg.version}`);
		process.exit(0);
	} else if (subcommand === '--help' || subcommand === '-h') {
		printHelp();
		process.exit(0);
	} else if (subcommand && !subcommand.startsWith('-')) {
		// Shorthand: atest <spec.yaml> = atest run <spec.yaml>
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

		await cmdRun(positionals[0], values);
	} else {
		printHelp();
		process.exit(subcommand ? 1 : 0);
	}
}

function printHelp() {
	console.log(`atest ${pkg.version} — LLM-judged CLI test runner

Usage:
  atest run <spec.yaml> [options]   Execute spec, judge with LLM
  atest show <trace.jsonl>           Replay trace as human-readable output
  atest <spec.yaml> [options]        Shorthand for "atest run"

Options (run):
  --api-key <key>       LLM API key (or ATEST_API_KEY env)
  --base-url <url>      LLM endpoint (or ATEST_BASE_URL env)
  --model <name>        Model name (or ATEST_MODEL env, required for LLM judgment)
  -o, --output <path>   JSONL trace path (default: <stem>-<timestamp>.jsonl)
  --no-trace            Disable trace output
  --dry-run             Execute commands, skip LLM judgment

Environment:
  ATEST_API_KEY         LLM API key
  ATEST_BASE_URL        LLM API endpoint
  ATEST_MODEL           LLM model name (required for LLM judgment)

CLI flags override environment variables.`);
}

main().catch((err) => {
	console.error('Fatal:', err);
	process.exit(1);
});
