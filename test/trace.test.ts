import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { truncateOutput, timestamp, defaultTracePath } from '../src/trace.js';

describe('truncateOutput', () => {
	it('returns short output unchanged', () => {
		const input = 'line1\nline2\nline3';
		assert.equal(truncateOutput(input), input);
	});

	it('truncates long output with head and tail', () => {
		const lines = Array.from({ length: 200 }, (_, i) => `line${i}`);
		const input = lines.join('\n');
		const result = truncateOutput(input);
		assert.ok(result.includes('[truncated'));
		assert.ok(result.includes('line0'));
		assert.ok(result.includes('line199'));
	});

	it('uses custom maxLines', () => {
		const lines = Array.from({ length: 200 }, (_, i) => `line${i}`);
		const input = lines.join('\n');
		const result = truncateOutput(input, 10);
		assert.ok(result.includes('[truncated'));
		assert.ok(result.includes('line0'));
	});

	it('preserves exactly maxLines without truncation', () => {
		const lines = Array.from({ length: 100 }, (_, i) => `line${i}`);
		const input = lines.join('\n');
		assert.equal(truncateOutput(input, 100), input);
	});
});

describe('timestamp', () => {
	it('returns YYYYMMDD-HHMMSS format', () => {
		const ts = timestamp();
		assert.match(ts, /^\d{8}-\d{6}$/);
	});

	it('returns current time (within 1 second)', () => {
		const ts = timestamp();
		const d = new Date();
		const p = (n: number) => String(n).padStart(2, '0');
		const expected = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
		assert.ok(ts.startsWith(expected));
	});
});

describe('defaultTracePath', () => {
	it('generates path from spec stem', () => {
		const path = defaultTracePath('/tmp/my-spec.yaml');
		assert.ok(path.includes('my-spec-'));
		assert.ok(path.endsWith('.jsonl'));
	});

	it('handles .yml extension', () => {
		const path = defaultTracePath('/tmp/my-spec.yml');
		assert.ok(path.includes('my-spec-'));
		assert.ok(path.endsWith('.jsonl'));
	});

	it('uses process.cwd() as directory', () => {
		const path = defaultTracePath('/tmp/spec.yaml');
		assert.ok(path.startsWith(process.cwd()));
	});
});
