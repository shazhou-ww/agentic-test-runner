import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, '..', 'dist', 'cli.js');
const EXAMPLES = join(__dirname, '..', 'examples');

function runAtest(args: string[]): { stdout: string; stderr: string; exitCode: number } {
	try {
		const stdout = execFileSync('node', [CLI_PATH, ...args], {
			encoding: 'utf-8',
			timeout: 30000,
		});
		return { stdout, stderr: '', exitCode: 0 };
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; status?: number };
		return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.status ?? 1 };
	}
}

describe('CLI', () => {
	it('shows version', () => {
		const result = runAtest(['--version']);
		assert.equal(result.exitCode, 0);
		assert.match(result.stdout, /atest \d+\.\d+\.\d+/);
	});

	it('shows help with -h', () => {
		const result = runAtest(['-h']);
		assert.equal(result.exitCode, 0);
		assert.match(result.stdout, /LLM-judged CLI test runner/);
	});

	it('shows help with --help', () => {
		const result = runAtest(['--help']);
		assert.equal(result.exitCode, 0);
		assert.match(result.stdout, /Usage:/);
	});

	it('errors on unknown command', () => {
		const result = runAtest(['bogus']);
		assert.equal(result.exitCode, 1);
		assert.match(result.stderr, /Unknown command/);
	});
});

describe('cmdRun — basic.yaml', () => {
	it('passes all 4 steps', () => {
		const result = runAtest(['run', join(EXAMPLES, 'basic.yaml'), '--no-trace']);
		assert.equal(result.exitCode, 0);
		assert.match(result.stdout, /All 4 steps passed/);
	});
});

describe('cmdRun — system-commands.yaml', () => {
	it('passes until the intentional false step', () => {
		const result = runAtest(['run', join(EXAMPLES, 'system-commands.yaml'), '--no-trace']);
		// Last step is `false` → exit 1
		assert.equal(result.exitCode, 1);
		assert.match(result.stdout, /PASS/);  // earlier steps pass
		assert.match(result.stdout, /FAIL/); // last step fails
	});
});

describe('cmdRun — retry.yaml', () => {
	it('passes with retry on transition step', () => {
		const result = runAtest(['run', join(EXAMPLES, 'retry.yaml'), '--no-trace']);
		assert.equal(result.exitCode, 0);
		assert.match(result.stdout, /All 2 steps passed/);
		assert.match(result.stdout, /retry/); // shows retry was needed
	});
});

describe('cmdRun — trace output', () => {
	it('writes trace file by default', () => {
		const tracePath = join('/tmp', 'atest-test-trace.jsonl');
		const result = runAtest([
			'run', join(EXAMPLES, 'basic.yaml'),
			'-o', tracePath,
		]);
		assert.equal(result.exitCode, 0);
		assert.match(result.stdout, /Trace:.*atest-test-trace\.jsonl/);
	});
});

describe('cmdRun — error handling', () => {
	it('errors on missing spec file', () => {
		const result = runAtest(['run', '/nonexistent/spec.yaml']);
		assert.equal(result.exitCode, 1);
		assert.match(result.stderr, /not found/i);
	});

	it('errors on missing spec argument', () => {
		const result = runAtest(['run']);
		assert.equal(result.exitCode, 1);
	});
});
