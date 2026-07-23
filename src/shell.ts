import { spawn, type ChildProcess } from 'node:child_process';
import type { ExecResult } from './types.js';

export class PersistentShell {
	private shell: ChildProcess;
	private stdoutBuf: string;
	private stderrBuf: string;
	private marker: string;

	constructor(cwd: string) {
		this.shell = spawn('bash', ['--noprofile', '--norc', '-s'], {
			cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		this.stdoutBuf = '';
		this.stderrBuf = '';
		this.marker = `__ATEST_MARKER_${Date.now()}_${Math.random().toString(36).slice(2)}__`;

		this.shell.stdout!.on('data', (data: Buffer) => {
			this.stdoutBuf += data.toString();
		});
		this.shell.stderr!.on('data', (data: Buffer) => {
			this.stderrBuf += data.toString();
		});
	}

	async exec(command: string, timeout = 30000): Promise<ExecResult> {
		this.stdoutBuf = '';
		this.stderrBuf = '';
		const startMarker = `${this.marker}START`;
		const endMarker = `${this.marker}END`;
		const exitMarker = `${this.marker}EXIT`;
		const cwdMarker = `${this.marker}CWD`;

		this.shell.stdin!.write(
			`echo "${startMarker}"; ${command}; echo "${exitMarker}$?"; echo "${cwdMarker}$(pwd)"; echo "${endMarker}"\n`,
		);

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
		const cwd =
			cwdStart !== -1 && cwdEnd !== -1
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

	private _waitForMarker(marker: string, timeout: number): Promise<string> {
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

	close(): void {
		this.shell.stdin!.write('exit\n');
		this.shell.kill();
	}
}
