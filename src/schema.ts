import { z } from 'zod';

// ─── Judge Schemas ─────────────────────────────────────────────

export const RetryConfigSchema = z.object({
	max: z.number().int().positive().default(3),
	interval: z.number().int().positive().default(10),
	backoff: z.boolean().default(false),
});

export const LLMJudgeSchema = z.object({
	type: z.literal('llm'),
	prompt: z.string().min(1),
});

export const JSONataJudgeSchema = z.object({
	type: z.literal('jsonata'),
	expr: z.string().min(1),
});

export const RegexJudgeSchema = z.object({
	type: z.literal('regex'),
	expr: z.string().min(1),
});

export const JudgeSchema = z.discriminatedUnion('type', [
	LLMJudgeSchema,
	JSONataJudgeSchema,
	RegexJudgeSchema,
]);

// ─── Test Spec Schema ─────────────────────────────────────────

export const TestStepSchema = z.object({
	command: z.string().min(1),
	judge: JudgeSchema.optional(),
	timeout: z.number().int().positive().default(30),
	retry: RetryConfigSchema.optional(),
});

export const TestSpecSchema = z.object({
	name: z.string(),
	description: z.string().optional(),
	cwd: z.string().optional(),
	setup: z.array(z.string()).optional(),
	teardown: z.array(z.string()).optional(),
	steps: z.array(TestStepSchema).min(1),
});

// ─── Trace Schemas ─────────────────────────────────────────────

export const VerdictSchema = z.enum(['PASS', 'FAIL', 'RETRY']);
export const JudgeTypeSchema = z.enum(['llm', 'jsonata', 'regex', 'exit_code', 'unknown']);

export const TraceMetaSchema = z.object({
	type: z.literal('meta'),
	name: z.string().nullable(),
	description: z.string().nullable(),
	cwd: z.string(),
	model: z.string(),
	base_url: z.string().nullable(),
	total_steps: z.number().int().nonnegative(),
	started_at: z.string(),
	timestamp: z.string(),
});

export const TraceLifecycleSchema = z.object({
	type: z.enum(['setup', 'teardown']),
	command: z.string(),
	stdout: z.string(),
	stderr: z.string(),
	exit_code: z.number().int(),
	timestamp: z.string(),
});

export const TraceStepSchema = z.object({
	type: z.literal('step'),
	index: z.number().int().nonnegative(),
	attempt: z.number().int().nonnegative(),
	command: z.string(),
	stdout: z.string(),
	stderr: z.string(),
	exit_code: z.number().int(),
	timed_out: z.boolean(),
	cwd: z.string().nullable(),
	judge_type: JudgeTypeSchema,
	judge_input: z.string().nullable(),
	judge_verdict: VerdictSchema,
	judge_reason: z.string(),
	judge_raw: z.string().nullable(),
	duration_ms: z.number().int().nonnegative(),
	timestamp: z.string(),
});

export const TraceSummarySchema = z.object({
	type: z.literal('summary'),
	total_steps: z.number().int().nonnegative(),
	executed_steps: z.number().int().nonnegative(),
	passed: z.number().int().nonnegative(),
	failed: z.number().int().nonnegative(),
	retried: z.number().int().nonnegative(),
	result: z.enum(['PASS', 'FAIL']),
	duration_ms: z.number().int().nonnegative(),
	ended_at: z.string(),
	timestamp: z.string(),
});

export const TraceLineSchema = z.discriminatedUnion('type', [
	TraceMetaSchema,
	TraceLifecycleSchema,
	TraceStepSchema,
	TraceSummarySchema,
]);
