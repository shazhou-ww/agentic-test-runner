#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { cmdRun } from './runner.js';
import { cmdShow } from './show.js';

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

function printHelp(): void {
	console.log(`atest ${pkg.version} — LLM-judged CLI test runner

Usage:
  atest run <spec.yaml> [options]   Execute spec, judge with LLM
  atest show <trace.jsonl>          Replay trace as human-readable output
  atest -V, --version               Print version
  atest -h, --help                  Show this help

Run "atest run --help" or "atest show --help" for subcommand details.`);
}

function printRunHelp(): void {
	console.log(`atest run — execute a test spec

Usage: atest run <spec.yaml> [options]

Options:
  --api-key <key>       LLM API key (or ATEST_API_KEY env)
  --base-url <url>      LLM endpoint (or ATEST_BASE_URL env)
  --model <name>        Model name (or ATEST_MODEL env, required for judge type: llm)
  -o, --output <path>   JSONL trace path (default: <stem>-<timestamp>.jsonl)
  --no-trace            Disable trace output
  -h, --help            Show this help

Environment:
  ATEST_API_KEY         LLM API key
  ATEST_BASE_URL        LLM API endpoint
  ATEST_MODEL           LLM model name (required for judge type: llm)

CLI flags override environment variables.`);
}

function printShowHelp(): void {
	console.log(`atest show — replay a trace as human-readable output

Usage: atest show <trace.jsonl>

Reads a JSONL trace file and prints the same human-readable output
that was shown during "atest run".`);
}

main().catch((err) => {
	console.error('Fatal:', err);
	process.exit(1);
});
