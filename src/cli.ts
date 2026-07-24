#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { cmdRun } from './runner.js';
import { cmdShow } from './show.js';
import { configPath, setConfigValue, initConfig, printEffectiveConfig } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

export async function main(): Promise<void> {
	const args = process.argv.slice(2);
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
				help: { type: 'boolean', short: 'h' },
			},
			allowPositionals: true,
			args: rest,
		});

		if (values.help) {
			printRunHelp();
			process.exit(0);
		}
		if (positionals.length === 0) {
			console.error('Usage: atest run <spec.yaml> [options]');
			console.error('Run "atest run --help" for details');
			process.exit(1);
		}

		await cmdRun(positionals[0]!, values);
	} else if (subcommand === 'show') {
		const { values, positionals } = parseArgs({
			options: {
				help: { type: 'boolean', short: 'h' },
			},
			allowPositionals: true,
			args: rest,
		});

		if (values.help) {
			printShowHelp();
			process.exit(0);
		}
		if (positionals.length === 0) {
			console.error('Usage: atest show <trace.jsonl>');
			process.exit(1);
		}

		await cmdShow(positionals[0]!);
	} else if (subcommand === 'config') {
		const configSub = rest[0];
		if (configSub === '--help' || configSub === '-h') {
			printConfigHelp();
		} else if (configSub === 'set') {
			const key = rest[1];
			if (!key || rest.length < 3) {
				console.error('Usage: atest config set <key> <value>');
				console.error('Keys: api_key, base_url, model');
				process.exit(1);
			}
			const value = rest.slice(2).join(' ');
			setConfigValue(key, value);
			console.log(`Set ${key} in ${configPath()}`);
		} else if (configSub === 'path') {
			console.log(configPath());
		} else if (configSub === 'init') {
			if (initConfig()) {
				console.log(`Created ${configPath()}`);
			} else {
				console.log(`Already exists: ${configPath()}`);
			}
		} else if (configSub === undefined) {
			printEffectiveConfig({});
		} else {
			console.error(`Unknown config subcommand: ${configSub}`);
			console.error('Run "atest config --help" for usage');
			process.exit(1);
		}
		process.exit(0);
	} else if (subcommand === '--version' || subcommand === '-V') {
		console.log(`atest ${pkg.version}`);
		process.exit(0);
	} else if (subcommand === '--help' || subcommand === '-h' || subcommand === undefined) {
		printHelp();
		process.exit(0);
	} else {
		console.error(`Unknown command: ${subcommand}`);
		printHelp();
		process.exit(1);
	}
}

const helpDir = join(__dirname, '..', 'help');

function loadHelp(filename: string): string {
	return readFileSync(join(helpDir, filename), 'utf8');
}

function printHelp(): void {
	console.log(loadHelp('main.md').replace('{{version}}', pkg.version));
}

function printRunHelp(): void {
	console.log(loadHelp('run.md'));
}

function printShowHelp(): void {
	console.log(loadHelp('show.md'));
}

function printConfigHelp(): void {
	console.log(loadHelp('config.md'));
}

main().catch((err) => {
	console.error('Fatal:', err);
	process.exit(1);
});
