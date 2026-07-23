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

export interface LLMJudge {
	type: 'llm';
	/** Natural language criteria for the LLM to judge against */
	prompt: string;
}

export interface JSONataJudge {
	type: 'jsonata';
	/** JSONata expression evaluated against { stdout, stderr, exit_code }. Truthy = PASS */
	expr: string;
}

export interface RegexJudge {
	type: 'regex';
	/** Regex pattern matched against stdout (trimmed). Match = PASS */
	expr: string;
}

export type Judge = LLMJudge | JSONataJudge | RegexJudge;

export interface TestStep {
	/** Shell command to execute */
	command: string;
	/**
	 * Judge configuration. If omitted, this is a "transition step" —
	 * auto-judged by exit code (0 = PASS, non-zero = FAIL or RETRY if retry configured).
	 */
	judge?: Judge;
	/** Timeout in seconds for the command itself (default: 30) */
	timeout?: number;
	/**
	 * Retry configuration for async/long-running operations.
	 * When enabled, the step can return RETRY and be re-executed after waiting.
	 */
	retry?: RetryConfig;
}

export interface TestSpec {
	/** Test case name (shown in stdout + trace meta) */
	name: string;
	/** What this test case tests (shown to LLM judge as context) */
	description?: string;
	/**
	 * Working directory for the persistent shell.
	 * Relative to the spec file's location. Machine-independent.
	 */
	cwd?: string;
	/** Commands to run before steps (not judged) */
	setup?: string[];
	/** Commands to run after steps (always runs, even on FAIL) */
	teardown?: string[];
	/** Test steps — the core of the spec */
	steps: TestStep[];
}

// ─── Internal Types ───────────────────────────────────────────────

export type Verdict = 'PASS' | 'FAIL' | 'RETRY';
export type JudgeType = 'llm' | 'jsonata' | 'regex' | 'exit_code' | 'unknown';

export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	timedOut: boolean;
	cwd: string | null;
}

export interface JudgeResult {
	verdict: Verdict;
	reason: string;
	raw: string | null;
	type: JudgeType;
	input: string | null;
}

export interface StepResult extends ExecResult {
	judgeReason: string | null;
	judgeVerdict: Verdict | null;
	attempt?: number;
}

export interface RunOptions {
	'api-key'?: string;
	'base-url'?: string;
	model?: string;
	output?: string;
	'no-trace'?: boolean;
	help?: boolean;
}

export interface JudgeContext {
	apiKey: string;
	baseUrl: string;
	model: string;
	testCase: TestSpec;
	stepResults: StepResult[];
	stepIndex: number;
	retryEnabled: boolean;
}

// ─── Trace JSONL (output) ─────────────────────────────────────────

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

export interface TraceLifecycle {
	type: 'setup' | 'teardown';
	command: string;
	stdout: string;
	stderr: string;
	exit_code: number;
	timestamp: string; // ISO 8601
}

export interface TraceStep {
	type: 'step';
	index: number;
	/** Retry attempt number (0 = first try, 1+ = retries) */
	attempt: number;
	command: string;
	stdout: string;
	stderr: string;
	exit_code: number;
	timed_out: boolean;
	/** Working directory at the time this step executed */
	cwd: string | null;
	/** Judge type: 'llm', 'jsonata', 'regex', or 'exit_code' (transition step) */
	judge_type: JudgeType;
	/** The prompt (llm), expression (jsonata/regex), or null (exit_code) */
	judge_input: string | null;
	judge_verdict: Verdict;
	judge_reason: string;
	/** Full raw LLM response (null for non-LLM judges) */
	judge_raw: string | null;
	duration_ms: number;
	timestamp: string; // ISO 8601
}

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
export type TraceLine = TraceMeta | TraceLifecycle | TraceStep | TraceSummary;
