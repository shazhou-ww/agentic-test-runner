import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	TestSpecSchema,
	TestStepSchema,
	JudgeSchema,
	RetryConfigSchema,
	TraceLineSchema,
	TraceStepSchema,
	TraceSummarySchema,
} from '../src/schema.js';

describe('TestSpecSchema', () => {
	it('validates a minimal valid spec', () => {
		const spec = {
			name: 'test',
			steps: [{ command: 'echo hello' }],
		};
		const result = TestSpecSchema.safeParse(spec);
		assert.ok(result.success);
		assert.equal(result.data!.steps[0].timeout, 30); // default
	});

	it('validates a full spec with judges', () => {
		const spec = {
			name: 'full test',
			description: 'A test',
			cwd: '/tmp',
			setup: ['mkdir -p /tmp/test'],
			teardown: ['rm -rf /tmp/test'],
			steps: [
				{ command: 'echo hello', judge: { type: 'regex', expr: 'hello' }, timeout: 5 },
				{ command: 'true', judge: { type: 'jsonata', expr: 'exit_code = 0' } },
				{ command: 'false', retry: { max: 3, interval: 1, backoff: true } },
			],
		};
		const result = TestSpecSchema.safeParse(spec);
		assert.ok(result.success);
	});

	it('rejects spec without steps', () => {
		const result = TestSpecSchema.safeParse({ name: 'bad' });
		assert.ok(!result.success);
	});

	it('rejects spec with empty steps array', () => {
		const result = TestSpecSchema.safeParse({ name: 'bad', steps: [] });
		assert.ok(!result.success);
	});

	it('rejects step without command', () => {
		const result = TestStepSchema.safeParse({ judge: { type: 'regex', expr: 'x' } });
		assert.ok(!result.success);
	});

	it('rejects step with empty command', () => {
		const result = TestStepSchema.safeParse({ command: '' });
		assert.ok(!result.success);
	});
});

describe('JudgeSchema', () => {
	it('validates llm judge', () => {
		const result = JudgeSchema.safeParse({ type: 'llm', prompt: 'output contains hello' });
		assert.ok(result.success);
	});

	it('validates jsonata judge', () => {
		const result = JudgeSchema.safeParse({ type: 'jsonata', expr: '$contains(stdout, "hello")' });
		assert.ok(result.success);
	});

	it('validates regex judge', () => {
		const result = JudgeSchema.safeParse({ type: 'regex', expr: '^hello$' });
		assert.ok(result.success);
	});

	it('rejects unknown judge type', () => {
		const result = JudgeSchema.safeParse({ type: 'custom', expr: 'x' });
		assert.ok(!result.success);
	});

	it('rejects llm judge without prompt', () => {
		const result = JudgeSchema.safeParse({ type: 'llm' });
		assert.ok(!result.success);
	});

	it('rejects llm judge with empty prompt', () => {
		const result = JudgeSchema.safeParse({ type: 'llm', prompt: '' });
		assert.ok(!result.success);
	});
});

describe('RetryConfigSchema', () => {
	it('applies defaults for empty object', () => {
		const result = RetryConfigSchema.parse({});
		assert.equal(result.max, 3);
		assert.equal(result.interval, 10);
		assert.equal(result.backoff, false);
	});

	it('accepts custom values', () => {
		const result = RetryConfigSchema.parse({ max: 5, interval: 2, backoff: true });
		assert.equal(result.max, 5);
		assert.equal(result.interval, 2);
		assert.equal(result.backoff, true);
	});

	it('rejects non-positive max', () => {
		const result = RetryConfigSchema.safeParse({ max: 0 });
		assert.ok(!result.success);
	});

	it('rejects negative interval', () => {
		const result = RetryConfigSchema.safeParse({ interval: -1 });
		assert.ok(!result.success);
	});
});

describe('TraceLineSchema', () => {
	it('validates a meta line', () => {
		const line = {
			type: 'meta',
			name: 'test',
			description: null,
			cwd: '/tmp',
			model: 'gpt-4',
			base_url: 'https://api.openai.com/v1',
			total_steps: 3,
			started_at: '2026-01-01T00:00:00Z',
			timestamp: '2026-01-01T00:00:00Z',
		};
		const result = TraceLineSchema.safeParse(line);
		assert.ok(result.success);
	});

	it('validates a step line', () => {
		const line = {
			type: 'step',
			index: 0,
			attempt: 0,
			command: 'echo hello',
			stdout: 'hello\n',
			stderr: '',
			exit_code: 0,
			timed_out: false,
			cwd: '/tmp',
			judge_type: 'regex',
			judge_input: 'hello',
			judge_verdict: 'PASS',
			judge_reason: 'regex matched',
			judge_raw: null,
			duration_ms: 50,
			timestamp: '2026-01-01T00:00:00Z',
		};
		const result = TraceStepSchema.safeParse(line);
		assert.ok(result.success);
	});

	it('validates a summary line', () => {
		const line = {
			type: 'summary',
			total_steps: 3,
			executed_steps: 3,
			passed: 2,
			failed: 1,
			retried: 0,
			result: 'FAIL',
			duration_ms: 1500,
			ended_at: '2026-01-01T00:00:01Z',
			timestamp: '2026-01-01T00:00:01Z',
		};
		const result = TraceSummarySchema.safeParse(line);
		assert.ok(result.success);
	});

	it('rejects invalid verdict', () => {
		const line = {
			type: 'step',
			index: 0,
			attempt: 0,
			command: 'echo hi',
			stdout: '',
			stderr: '',
			exit_code: 0,
			timed_out: false,
			cwd: null,
			judge_type: 'exit_code',
			judge_input: null,
			judge_verdict: 'MAYBE', // invalid
			judge_reason: 'test',
			judge_raw: null,
			duration_ms: 10,
			timestamp: '2026-01-01T00:00:00Z',
		};
		const result = TraceStepSchema.safeParse(line);
		assert.ok(!result.success);
	});

	it('discriminates by type field', () => {
		const metaLine = { type: 'meta', name: 'x', description: null, cwd: '/', model: '', base_url: null, total_steps: 0, started_at: '', timestamp: '' };
		const stepLine = { type: 'step', index: 0, attempt: 0, command: '', stdout: '', stderr: '', exit_code: 0, timed_out: false, cwd: null, judge_type: 'exit_code', judge_input: null, judge_verdict: 'PASS', judge_reason: '', judge_raw: null, duration_ms: 0, timestamp: '' };
		const summaryLine = { type: 'summary', total_steps: 0, executed_steps: 0, passed: 0, failed: 0, retried: 0, result: 'PASS', duration_ms: 0, ended_at: '', timestamp: '' };

		assert.ok(TraceLineSchema.safeParse(metaLine).success);
		assert.ok(TraceLineSchema.safeParse(stepLine).success);
		assert.ok(TraceLineSchema.safeParse(summaryLine).success);
		assert.ok(!TraceLineSchema.safeParse({ type: 'unknown' }).success);
	});
});
