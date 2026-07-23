import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseJudgeResponse, evaluateRegex, evaluateJsonata } from '../src/judge.js';

describe('parseJudgeResponse', () => {
	it('parses PASS', () => {
		const result = parseJudgeResponse('VERDICT: PASS\nREASON: all good');
		assert.equal(result.verdict, 'PASS');
		assert.equal(result.reason, 'all good');
	});

	it('parses FAIL', () => {
		const result = parseJudgeResponse('VERDICT: FAIL\nREASON: output missing');
		assert.equal(result.verdict, 'FAIL');
		assert.equal(result.reason, 'output missing');
	});

	it('parses RETRY', () => {
		const result = parseJudgeResponse('VERDICT: RETRY\nREASON: service starting');
		assert.equal(result.verdict, 'RETRY');
		assert.equal(result.reason, 'service starting');
	});

	it('defaults to FAIL on malformed response', () => {
		const result = parseJudgeResponse('something random');
		assert.equal(result.verdict, 'FAIL');
		assert.equal(result.reason, 'something random');
	});

	it('is case-insensitive', () => {
		const result = parseJudgeResponse('verdict: pass\nreason: ok');
		assert.equal(result.verdict, 'PASS');
		assert.equal(result.reason, 'ok');
	});

	it('truncates long reason to 200 chars on fallback', () => {
		const longText = 'A'.repeat(300);
		const result = parseJudgeResponse(longText);
		// When no VERDICT/REASON found, falls back to response.slice(0, 200)
		assert.equal(result.reason.length, 200);
	});
});

describe('evaluateRegex', () => {
	it('matches stdout', () => {
		assert.equal(evaluateRegex('hello', { stdout: 'hello world' }), true);
	});

	it('does not match', () => {
		assert.equal(evaluateRegex('xyz', { stdout: 'hello world' }), false);
	});

	it('trims stdout before matching', () => {
		assert.equal(evaluateRegex('^hello$', { stdout: 'hello\n' }), true);
	});

	it('supports anchors', () => {
		assert.equal(evaluateRegex('^hello$', { stdout: 'hello' }), true);
		assert.equal(evaluateRegex('^hello$', { stdout: 'hello world' }), false);
	});

	it('throws on invalid regex', () => {
		assert.throws(() => evaluateRegex('[', { stdout: 'test' }));
	});
});

describe('evaluateJsonata', () => {
	it('returns truthy for matching expression', async () => {
		const result = await evaluateJsonata('$contains(stdout, "hello")', {
			stdout: 'hello world',
			stderr: '',
			exit_code: 0,
		});
		assert.equal(result, true);
	});

	it('returns falsy for non-matching expression', async () => {
		const result = await evaluateJsonata('$contains(stdout, "xyz")', {
			stdout: 'hello world',
			stderr: '',
			exit_code: 0,
		});
		assert.equal(result, false);
	});

	it('can check exit_code', async () => {
		const result = await evaluateJsonata('exit_code = 0', {
			stdout: '',
			stderr: '',
			exit_code: 0,
		});
		assert.equal(result, true);
	});

	it('can combine conditions with and', async () => {
		const result = await evaluateJsonata(
			'$contains(stdout, "line1") and $contains(stdout, "line2")',
			{ stdout: 'line1\nline2', stderr: '', exit_code: 0 },
		);
		assert.equal(result, true);
	});

	it('can access stderr', async () => {
		const result = await evaluateJsonata('$contains(stderr, "error")', {
			stdout: '',
			stderr: 'something went error',
			exit_code: 1,
		});
		assert.equal(result, true);
	});

	it('throws on invalid expression', async () => {
		await assert.rejects(() => evaluateJsonata('!!!invalid!!!', {}));
	});
});
