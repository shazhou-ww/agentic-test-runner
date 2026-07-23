import jsonata from 'jsonata';
import type {
	ExecResult,
	JudgeContext,
	JudgeResult,
	LLMJudge,
	StepResult,
	TestSpec,
	Verdict,
} from './types.js';

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

interface LLMMessage {
	role: string;
	content: string | null;
	tool_calls?: Array<{
		id: string;
		type: string;
		function: { name: string; arguments: string };
	}>;
	tool_call_id?: string;
}

export async function callJudge(params: {
	messages: LLMMessage[];
	apiKey: string;
	baseUrl: string;
	model: string;
}): Promise<string> {
	const url = `${params.baseUrl.replace(/\/+$/, '')}/chat/completions`;
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${params.apiKey}`,
		},
		body: JSON.stringify({
			model: params.model,
			messages: params.messages,
			temperature: 0,
			max_tokens: 256,
		}),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`LLM API error ${response.status}: ${text.slice(0, 200)}`);
	}

	const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
	return data.choices?.[0]?.message?.content ?? '';
}

export function parseJudgeResponse(response: string): { verdict: Verdict; reason: string } {
	const match = response.match(/VERDICT:\s*(PASS|FAIL|RETRY)/i);
	const reasonMatch = response.match(/REASON:\s*(.+)/i);
	const verdict = match ? (match[1].toUpperCase() as Verdict) : 'FAIL';
	const reason = reasonMatch ? reasonMatch[1].trim() : response.slice(0, 200);
	return { verdict, reason };
}

export async function evaluateJsonata(expr: string, input: unknown): Promise<unknown> {
	const expression = jsonata(expr);
	return await expression.evaluate(input);
}

export function evaluateRegex(pattern: string, input: { stdout: string }): boolean {
	const re = new RegExp(pattern);
	return re.test(input.stdout.trim());
}

export function assembleJudgeMessages(
	testCase: TestSpec,
	stepResults: StepResult[],
	currentStepIndex: number,
): LLMMessage[] {
	const step = testCase.steps[currentStepIndex];
	const judge = step.judge as LLMJudge;
	const retryEnabled = !!step.retry;

	const messages: LLMMessage[] = [
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
			tool_calls: [
				{
					id: `call_${i + 1}`,
					type: 'function',
					function: { name: 'terminal', arguments: JSON.stringify({ command: s.command }) },
				},
			],
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
			messages.push({ role: 'user', content: `Step ${i + 1} 预期: ${s.judge?.type === 'llm' ? s.judge.prompt : '(transition)'}` });
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

export async function runJudge(
	step: TestSpec['steps'][number],
	execResult: ExecResult,
	ctx: JudgeContext,
): Promise<JudgeResult> {
	const judge = step.judge;

	if (!judge) {
		// Transition step — exit code judge
		const pass = execResult.exitCode === 0;
		return {
			verdict: pass ? 'PASS' : 'FAIL',
			reason: pass
				? 'exit code 0 (transition step)'
				: `exit code ${execResult.exitCode} (transition step, expected 0)`,
			raw: null,
			type: 'exit_code',
			input: null,
		};
	}

	if (judge.type === 'llm') {
		const messages = assembleJudgeMessages(ctx.testCase, ctx.stepResults, ctx.stepIndex);
		const judgeResponse = await callJudge({
			messages,
			apiKey: ctx.apiKey,
			baseUrl: ctx.baseUrl,
			model: ctx.model,
		});
		const { verdict, reason } = parseJudgeResponse(judgeResponse);
		return { verdict, reason, raw: judgeResponse, type: 'llm', input: judge.prompt };
	}

	if (judge.type === 'jsonata') {
		const input = {
			stdout: execResult.stdout,
			stderr: execResult.stderr,
			exit_code: execResult.exitCode,
		};
		let result: unknown;
		try {
			result = await evaluateJsonata(judge.expr, input);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { verdict: 'FAIL', reason: `jsonata error: ${msg}`, raw: null, type: 'jsonata', input: judge.expr };
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
		const input = {
			stdout: execResult.stdout,
			stderr: execResult.stderr,
			exit_code: execResult.exitCode,
		};
		let pass: boolean;
		try {
			pass = evaluateRegex(judge.expr, input);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { verdict: 'FAIL', reason: `regex error: ${msg}`, raw: null, type: 'regex', input: judge.expr };
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
	return {
		verdict: 'FAIL',
		reason: `unknown judge type: ${(judge as { type: string }).type}`,
		raw: null,
		type: 'unknown',
		input: JSON.stringify(judge),
	};
}
