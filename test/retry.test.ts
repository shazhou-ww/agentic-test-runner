import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getRetryConfig, waitTime } from '../src/runner.js';
import type { TestStep } from '../src/types.js';

describe('getRetryConfig', () => {
	it('returns null when no retry', () => {
		const step: TestStep = { command: 'echo hi' };
		assert.equal(getRetryConfig(step), null);
	});

	it('returns defaults when retry is empty object', () => {
		const step: TestStep = { command: 'echo hi', retry: {} };
		const rc = getRetryConfig(step);
		assert.notEqual(rc, null);
		assert.equal(rc!.max, 3);
		assert.equal(rc!.interval, 10);
		assert.equal(rc!.backoff, false);
	});

	it('returns custom values', () => {
		const step: TestStep = {
			command: 'echo hi',
			retry: { max: 5, interval: 2, backoff: true },
		};
		const rc = getRetryConfig(step);
		assert.equal(rc!.max, 5);
		assert.equal(rc!.interval, 2);
		assert.equal(rc!.backoff, true);
	});

	it('partial config uses defaults for missing fields', () => {
		const step: TestStep = { command: 'echo hi', retry: { max: 7 } };
		const rc = getRetryConfig(step);
		assert.equal(rc!.max, 7);
		assert.equal(rc!.interval, 10); // default
		assert.equal(rc!.backoff, false); // default
	});
});

describe('waitTime', () => {
	it('returns 0 when no retry config', () => {
		assert.equal(waitTime(null, 0), 0);
		assert.equal(waitTime(null, 5), 0);
	});

	it('returns fixed interval without backoff', () => {
		const rc = { max: 3, interval: 5, backoff: false };
		assert.equal(waitTime(rc, 0), 5);
		assert.equal(waitTime(rc, 1), 5);
		assert.equal(waitTime(rc, 2), 5);
	});

	it('returns exponential backoff', () => {
		const rc = { max: 3, interval: 2, backoff: true };
		assert.equal(waitTime(rc, 0), 2); // 2 * 2^0 = 2
		assert.equal(waitTime(rc, 1), 4); // 2 * 2^1 = 4
		assert.equal(waitTime(rc, 2), 8); // 2 * 2^2 = 8
		assert.equal(waitTime(rc, 3), 16); // 2 * 2^3 = 16
	});

	it('interval=1 with backoff gives powers of 2', () => {
		const rc = { max: 5, interval: 1, backoff: true };
		assert.equal(waitTime(rc, 0), 1);
		assert.equal(waitTime(rc, 1), 2);
		assert.equal(waitTime(rc, 2), 4);
		assert.equal(waitTime(rc, 3), 8);
	});
});
