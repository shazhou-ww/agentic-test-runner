import { join, basename } from 'node:path';
import type { TraceMeta, TraceLifecycle, TraceStep, TraceSummary } from './types.js';

export function timestamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function defaultTracePath(specPath: string): string {
	const stem = basename(specPath).replace(/\.ya?ml$/, '');
	return join(process.cwd(), `${stem}-${timestamp()}.jsonl`);
}

export function truncateOutput(output: string, maxLines = 100): string {
	const lines = output.split('\n');
	if (lines.length <= maxLines) return output;
	const head = lines.slice(0, 40).join('\n');
	const tail = lines.slice(-40).join('\n');
	return `${head}\n... [truncated ${lines.length - 80} lines] ...\n${tail}`;
}

export function printBanner(meta: TraceMeta, tracePath: string | null): void {
	console.log(`\n🧪 atest — LLM-judged CLI test runner`);
	console.log(`   Case: ${meta.name ?? '(unnamed)'}`);
	console.log(`   Steps: ${meta.total_steps ?? '?'}`);
	console.log(`   Judge: ${meta.model || '(none)'} ${meta.base_url ? '@ ' + meta.base_url : ''}`);
	if (meta.cwd) console.log(`   CWD: ${meta.cwd}`);
	if (tracePath) console.log(`   Trace: ${tracePath}`);
	console.log('');
}

export function printSetup(line: TraceLifecycle): void {
	console.log(`  [setup] $ ${line.command}`);
}

export function printStep(line: TraceStep, totalSteps: number): void {
	const attemptStr = line.attempt > 0 ? ` (retry ${line.attempt})` : '';
	console.log(`\n━━━ Step ${line.index + 1}/${totalSteps}${attemptStr} ━━━`);
	console.log(`  $ ${line.command}`);
	console.log(`  ${truncateOutput(line.stdout)}`);
	if (line.stderr) {
		console.log(`  ${truncateOutput(line.stderr)}`);
	}
	console.log(`  [exit: ${line.exit_code}]`);

	if (line.judge_verdict === 'RETRY') {
		console.log(`  🔄 RETRY: ${line.judge_reason}`);
	} else if (line.judge_verdict === 'PASS') {
		console.log(`  ✅ PASS: ${line.judge_reason}`);
	} else {
		console.log(`  ❌ FAIL: ${line.judge_reason}`);
	}
}

export function printTeardown(line: TraceLifecycle): void {
	console.log(`  [teardown] $ ${line.command}`);
}

export function printSummary(line: TraceSummary, tracePath: string | null): void {
	console.log('\n━━━ Summary ━━━');
	if (line.result === 'PASS') {
		console.log(`✅ All ${line.executed_steps} steps passed!`);
	} else {
		console.log(`❌ ${line.passed}/${line.executed_steps} steps passed`);
	}
	if (line.retried > 0) {
		console.log(`🔄 ${line.retried} step(s) needed retry`);
	}
	if (tracePath) {
		console.log(`📊 Trace: ${tracePath}`);
	}
}
