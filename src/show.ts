import { readFileSync, existsSync } from 'node:fs';
import {
	printBanner,
	printSetup,
	printStep,
	printTeardown,
	printSummary,
} from './trace.js';
import { TraceLineSchema } from './schema.js';
import type { TraceLine } from './types.js';

export async function cmdShow(tracePath: string): Promise<void> {
	if (!existsSync(tracePath)) {
		console.error(`Trace file not found: ${tracePath}`);
		process.exit(1);
	}

	const raw = readFileSync(tracePath, 'utf-8');
	const lines = raw.trim().split('\n').map((l) => {
		const parsed = JSON.parse(l);
		const result = TraceLineSchema.safeParse(parsed);
		if (!result.success) {
			console.error(`Invalid trace line: ${result.error.issues.map(i => i.message).join(', ')}`);
			process.exit(1);
		}
		return result.data as TraceLine;
	});

	let totalSteps = 0;

	for (const line of lines) {
		switch (line.type) {
			case 'meta':
				totalSteps = line.total_steps ?? 0;
				printBanner(line, tracePath);
				break;
			case 'setup':
				printSetup(line);
				break;
			case 'step':
				printStep(line, totalSteps);
				break;
			case 'teardown':
				printTeardown(line);
				break;
			case 'summary':
				printSummary(line, tracePath);
				break;
		}
	}

	process.exit(0);
}
