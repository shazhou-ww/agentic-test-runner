#!/usr/bin/env node

/**
 * atest — LLM-judged CLI test runner
 *
 * Spec: YAML defines TestStep[] = { command, judge_prompt, timeout }
 * Execution: run each command in a persistent shell, collect output
 * Judgment: assemble fake tool-call context, let LLM judge PASS/FAIL per step
 * Trace: output JSONL trace with every step's command, output, judge verdict, and final result
 *
 * Usage:
 *   atest <test-case.yaml> [options]
 *
 * Options:
 *   --api-key <key>     LLM API key (or JUDGE_API_KEY env)
 *   --base-url <url>    LLM API endpoint (or JUDGE_BASE_URL env)
 *   --model <name>      LLM model name (or JUDGE_MODEL env, default: glm-5.2)
 *   --provider <name>   Provider preset: dashscope | copilot
 *   --output <path>     Write JSONL trace to file (default: <testcase-stem>.trace.jsonl)
 *   --no-trace          Disable trace output
 *   --verbose           Print full LLM responses
 *   --dry-run           Execute commands but skip LLM judgment
 *
 * Provider presets (use --provider <name>):
 *   dashscope  → https://dashscope.aliyuncs.com/compatible-mode/v1 + glm-5.2
 *   copilot    → http://127.0.0.1:4142/v1 + claude-opus-4.6
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';

// ─── Provider Presets ──────────────────────────────────────────────

const PROVIDERS = {
	dashscope: {
		baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
		model: 'glm-5.2',
	},
	copilot: {
		baseUrl: 'http://127.0.0.1:4142/v1',
		model: 'claude-opus-4.6',
	},
};

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
		this.shell = spawn('bash', ['--noprofile', '--norc', '-i'], {
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

	/**
	 * Execute a command in the persistent shell.
	 * Returns { stdout, stderr, exitCode }
	 */
	async exec(command, timeout = 30000) {
		this.buffer = '';
		const startMarker = `${this.marker}START`;
		const endMarker = `${this.marker}END`;
		const exitMarker = `${this.marker}EXIT`;

		// Write command with markers
		this.shell.stdin.write(`echo "${startMarker}"; ${command}; echo "${exitMarker}$?"; echo "${endMarker}"\n`);

		// Wait for end marker
		const result = await this._waitForMarker(endMarker, timeout);

		// Parse output between markers
		const startIdx = result.indexOf(startMarker);
		const endIdx = result.indexOf(exitMarker);
		if (startIdx === -1 || endIdx === -1) {
			return { stdout: result, exitCode: -1, timedOut: true };
		}

		let output = result.slice(startIdx + startMarker.length + 1, endIdx);
		// Strip leading newline from echo
		if (output.startsWith('\n')) output = output.slice(1);

		// Extract exit code
		const exitLine = result.slice(endIdx + exitMarker.length, result.indexOf(endMarker, endIdx + 1));
		const exitCode = Number.parseInt(exitLine.trim(), 10);

		return { stdout: output, exitCode: Number.isNaN(exitCode) ? -1 : exitCode, timedOut: false };
	}

	_waitForMarker(marker, timeout) {
		return new Promise((resolve, reject) => {
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

/**
 * Assemble messages for LLM judgment.
 *
 * Structure:
 * - system: judge system prompt
 * - user: case overview
 * - assistant: fake terminal tool_call (step 1)
 * - tool: result 1 (with exit code)
 * - user: judge prompt for step 1
 * - assistant: (judge's PASS response, if passed)
 * - assistant: fake terminal tool_call (step 2)
 * - tool: result 2
 * - user: judge prompt for step 2
 * ...
 */
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

		// Fake tool call — makes the LLM think it executed this command
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

		// Tool result — actual execution output
		const toolContent = `[exit: ${result.exitCode}]\n${result.stdout}`;
		messages.push({
			role: 'tool',
			tool_call_id: `call_${i + 1}`,
			content: toolContent,
		});

		if (i < currentStepIndex) {
			// Previous step already judged — add the judge response
			messages.push({
				role: 'user',
				content: `Step ${i + 1} 预期: ${step.judge_prompt}`,
			});
			messages.push({
				role: 'assistant',
				content: `VERDICT: PASS\nREASON: ${result.judgeReason ?? 'Passed'}`,
			});
		} else {
			// Current step — this is what we want the LLM to judge
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

/**
 * Build the default trace output path from the test case path.
 * example.yaml → example.trace.jsonl
 */
function defaultTracePath(testCasePath) {
	const stem = basename(testCasePath).replace(/\.ya?ml$/, '');
	return join(dirname(testCasePath), `${stem}.trace.jsonl`);
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
	const { values, positionals } = parseArgs({
		options: {
			'api-key': { type: 'string' },
			'base-url': { type: 'string' },
			model: { type: 'string' },
			provider: { type: 'string' },
			output: { type: 'string' },
			'no-trace': { type: 'boolean', default: false },
			'dry-run': { type: 'boolean', default: false },
			verbose: { type: 'boolean', default: false },
		},
		allowPositionals: true,
	});

	if (positionals.length === 0) {
		console.error('Usage: atest <test-case.yaml> [options]');
		console.error('  --provider dashscope|copilot  Provider preset');
		console.error('  --api-key <key>               LLM API key (or JUDGE_API_KEY env)');
		console.error('  --base-url <url>              LLM endpoint (or JUDGE_BASE_URL env)');
		console.error('  --model <name>                Model name (or JUDGE_MODEL env)');
		console.error('  --output <path>               JSONL trace output path');
		console.error('  --no-trace                    Disable trace output');
		console.error('  --dry-run                     Execute commands, skip LLM judgment');
		console.error('  --verbose                     Print full LLM responses');
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

	// Resolve provider config
	const preset = values.provider ? PROVIDERS[values.provider] : null;
	const apiKey = values['api-key'] ?? process.env.JUDGE_API_KEY ?? '';
	const baseUrl = values['base-url'] ?? process.env.JUDGE_BASE_URL ?? preset?.baseUrl ?? '';
	const model = values.model ?? process.env.JUDGE_MODEL ?? preset?.model ?? 'glm-5.2';

	if (!values['dry-run'] && !apiKey) {
		console.error('No API key. Set JUDGE_API_KEY or use --api-key or --provider');
		process.exit(1);
	}

	// Trace config
	const enableTrace = !values['no-trace'];
	const tracePath = enableTrace ? (values.output ?? defaultTracePath(testCasePath)) : null;
	const traceLines = [];

	const startedAt = new Date().toISOString();

	console.log(`\n🧪 atest — LLM-judged CLI test runner`);
	console.log(`   Case: ${testCase.name ?? testCasePath}`);
	console.log(`   Steps: ${testCase.steps.length}`);
	console.log(`   Judge: ${model} @ ${baseUrl || '(dry-run)'}`);
	console.log(`   CWD: ${testCase.cwd ?? process.cwd()}`);
	if (tracePath) {
		console.log(`   Trace: ${tracePath}`);
	}
	console.log('');

	// Trace: meta line
	if (enableTrace) {
		traceLines.push(JSON.stringify({
			type: 'meta',
			name: testCase.name ?? null,
			description: testCase.description ?? null,
			cwd: testCase.cwd ?? null,
			model,
			base_url: baseUrl || null,
			total_steps: testCase.steps.length,
			started_at: startedAt,
		}));
	}

	// Setup persistent shell
	const shell = new PersistentShell(testCase.cwd ?? process.cwd());

	// Run setup commands
	if (testCase.setup) {
		for (const cmd of testCase.setup) {
			console.log(`  [setup] $ ${cmd}`);
			const setupResult = await shell.exec(cmd, 10000);
			if (enableTrace) {
				traceLines.push(JSON.stringify({
					type: 'setup',
					command: cmd,
					exit_code: setupResult.exitCode,
				}));
			}
		}
	}

	const stepResults = [];
	let allPassed = true;
	const stepStartTime = Date.now();

	try {
		for (let i = 0; i < testCase.steps.length; i++) {
			const step = testCase.steps[i];
			const timeout = (step.timeout ?? 30) * 1000;
			const stepStart = Date.now();

			console.log(`\n━━━ Step ${i + 1}/${testCase.steps.length} ━━━`);
			console.log(`  $ ${step.command}`);

			// Execute command
			const result = await shell.exec(step.command, timeout);
			const truncated = truncateOutput(result.stdout);
			console.log(`  ${truncated}`);
			console.log(`  [exit: ${result.exitCode}]`);
			const stepDuration = Date.now() - stepStart;

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
						judge_prompt: step.judge_prompt ?? null,
						judge_verdict: 'SKIP',
						judge_reason: 'dry-run',
						duration_ms: stepDuration,
					}));
				}
				continue;
			}

			// Push current result before assembly (judgeReason filled after)
			stepResults.push({ ...result, judgeReason: null });

			// Assemble messages for this step's judgment
			const messages = assembleJudgeMessages(testCase, stepResults, i);

			// Call LLM judge
			const response = await callJudge({ messages, apiKey, baseUrl, model });
			const { pass, reason } = parseJudgeResponse(response);

			if (values.verbose) {
				console.log(`  [judge response] ${response}`);
			}

			stepResults[i].judgeReason = reason;
			stepResults[i].judgeVerdict = pass ? 'PASS' : 'FAIL';

			// Trace: step line
			if (enableTrace) {
				traceLines.push(JSON.stringify({
					type: 'step',
					index: i,
					command: step.command,
					stdout: result.stdout,
					exit_code: result.exitCode,
					judge_prompt: step.judge_prompt ?? null,
					judge_verdict: pass ? 'PASS' : 'FAIL',
					judge_reason: reason,
					judge_raw: values.verbose ? response : null,
					duration_ms: stepDuration,
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
						exit_code: teardownResult.exitCode,
					}));
				}
			}
		}
		shell.close();
	}

	const totalDuration = Date.now() - stepStartTime;
	const endedAt = new Date().toISOString();

	// Summary
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

	// Trace: summary line
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
		}));

		// Write trace file
		writeFileSync(tracePath, traceLines.join('\n') + '\n');
		console.log(`📊 Trace written to: ${tracePath}`);
	}

	process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
	console.error('Fatal:', err);
	process.exit(1);
});
