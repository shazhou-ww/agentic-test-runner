import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PersistentShell } from '../src/shell.js';

describe('PersistentShell', () => {
	let shell: PersistentShell;

	afterEach(() => {
		if (shell) shell.close();
	});

	it('executes simple command and captures stdout', async () => {
		shell = new PersistentShell('/tmp');
		const result = await shell.exec('echo hello');
		assert.equal(result.exitCode, 0);
		assert.match(result.stdout, /hello/);
		assert.equal(result.stderr, '');
	});

	it('captures stderr separately', async () => {
		shell = new PersistentShell('/tmp');
		const result = await shell.exec('echo err >&2; echo out');
		assert.equal(result.exitCode, 0);
		assert.match(result.stdout, /out/);
		assert.match(result.stderr, /err/);
	});

	it('captures non-zero exit code', async () => {
		shell = new PersistentShell('/tmp');
		const result = await shell.exec('sh -c "exit 42"');
		assert.equal(result.exitCode, 42);
	});

	it('tracks cwd after cd', async () => {
		shell = new PersistentShell('/tmp');
		const result = await shell.exec('cd /tmp && pwd');
		assert.equal(result.cwd, '/tmp');
	});

	it('maintains state between commands', async () => {
		shell = new PersistentShell('/tmp');
		await shell.exec('export FOO=bar');
		const result = await shell.exec('echo $FOO');
		assert.match(result.stdout, /bar/);
	});

	it('handles command with no output', async () => {
		shell = new PersistentShell('/tmp');
		const result = await shell.exec('true');
		assert.equal(result.exitCode, 0);
		assert.equal(result.stdout.trim(), '');
	});

	it('handles multi-line output', async () => {
		shell = new PersistentShell('/tmp');
		const result = await shell.exec('echo "line1\nline2\nline3"');
		assert.match(result.stdout, /line1/);
		assert.match(result.stdout, /line2/);
		assert.match(result.stdout, /line3/);
	});

	it('handles commands with special characters', async () => {
		shell = new PersistentShell('/tmp');
		const result = await shell.exec('echo "hello & world | ; test"');
		assert.match(result.stdout, /hello & world \| ; test/);
	});

	it('times out on long-running command', async () => {
		shell = new PersistentShell('/tmp');
		const result = await shell.exec('sleep 10', 500); // 500ms timeout
		assert.equal(result.timedOut, true);
	});
});
