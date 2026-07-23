/**
 * atest — Type definitions for test spec (YAML) and trace (JSONL)
 */

// ─── Test Spec (YAML input) ───────────────────────────────────────

export interface RetryConfig {
	/** Max retry attempts (not counting the first try). Default: 3 */
	max?: number;
	/** Seconds to wait between retries. Default: 10 */
	interval?: number;
	/** false = fixed interval, true = exponential backoff (interval × 2^attempt). Default: false */
	backoff?: boolean;
}

export interface TestSpec {
	/** Test case name (shown in stdout + trace meta) */
	name: string;

	/** What this test case tests (shown to LLM judge as context) */
	description?: string;

	/**
	 * Working directory for the persistent shell.
	 * Relative to the spec file's location. Machine-independent.
	 * Example: "./test-workspace" or "../shared/fixtures"
	 */
	cwd?: string;

	/** Commands to run before steps (not judged) */
	setup?: string[];

	/** Commands to run after steps (always runs, even on FAIL) */
	teardown?: string[];

	/** Test steps — the core of the spec */
	steps: TestStep[];
}

export interface TestStep {
	/** Shell command to execute */
	command: string;

	/**
	 * Criteria for the LLM to judge PASS/FAIL/RETRY (natural language).
	 * If omitted, this is a "transition step" — auto-judged by exit code
	 * (0 = PASS, non-zero = FAIL or RETRY if retry configured), no LLM call.
	 */
	judge_prompt?: string;

	/** Timeout in seconds for the command itself (default: 30) */
	timeout?: number;

	/**
	 * Retry configuration for async/long-running operations.
	 * When enabled, the step can return RETRY and be re-executed after waiting.
	 * For judged steps: LLM can return RETRY verdict.
	 * For transition steps: non-zero exit code triggers RETRY.
	 */
	retry?: RetryConfig;
}

// ─── Trace JSONL (output) ─────────────────────────────────────────

/** First line of every trace file */
export interface TraceMeta {
	type: 'meta';
	name: string | null;
	description: string | null;
	cwd: string;
	model: string;
	base_url: string | null;
	total_steps: number;
	started_at: string; // ISO 8601
	timestamp: string; // ISO 8601
}

/** Setup or teardown command record */
export interface TraceLifecycle {
	type: 'setup' | 'teardown';
	command: string;
	stdout: string;
	exit_code: number;
	timestamp: string; // ISO 8601
}

/** One per test step attempt — the verbose record */
export interface TraceStep {
	type: 'step';
	index: number;
	/** Retry attempt number (0 = first try, 1 = first retry, etc.) */
	attempt: number;
	command: string;
	stdout: string;
	exit_code: number;
	timed_out: boolean;
	/** Working directory at the time this step executed (after any cd in prior steps) */
	cwd: string | null;
	judge_prompt: string | null;
	judge_verdict: 'PASS' | 'FAIL' | 'RETRY';
	judge_reason: string;
	/** Full raw LLM response (null for transition steps) */
	judge_raw: string | null;
	/** "llm" if judged by LLM, "exit_code" if auto-judged (transition step) */
	judge_method: 'llm' | 'exit_code';
	duration_ms: number;
	timestamp: string; // ISO 8601
}

/** Last line of every trace file */
export interface TraceSummary {
	type: 'summary';
	total_steps: number;
	executed_steps: number;
	passed: number;
	failed: number;
	/** Number of steps that needed at least one retry */
	retried: number;
	result: 'PASS' | 'FAIL';
	duration_ms: number;
	ended_at: string; // ISO 8601
	timestamp: string; // ISO 8601
}

/** Union of all possible trace lines */
export type TraceLine =
	| TraceMeta
	| TraceLifecycle
	| TraceStep
	| TraceSummary;
