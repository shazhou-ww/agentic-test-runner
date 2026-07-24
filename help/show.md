atest show — replay a trace as human-readable output

Usage: atest show <trace.jsonl>

Reads a JSONL trace file and prints the same human-readable output
that was shown during "atest run".

═══════════════════════════════════════════════════════════════

Trace structure (JSONL — one JSON object per line):

  meta       Test metadata (name, model, total_steps, started_at)
  setup      Setup command records (one per command, not judged)
  step       Test step records (one per attempt; retries share index, different attempt)
  teardown   Teardown command records (not judged)
  summary    Final result (passed/failed/retried counts, result: PASS|FAIL)

═══════════════════════════════════════════════════════════════

Step record fields:

  index          Step number (0-based)
  attempt        Retry attempt (0 = first try, 1+ = retries)
  command        Shell command executed
  stdout         Full command stdout (not truncated in trace)
  stderr         Full command stderr
  exit_code      Process exit code
  timed_out      Whether the step timed out
  cwd            Working directory when step executed
  judge_type     llm | jsonata | regex | exit_code (transition)
  judge_input    The prompt (llm) or expression (jsonata/regex) or null
  judge_verdict  PASS | FAIL | RETRY
  judge_reason   One-line explanation
  judge_raw      Full raw LLM response (null for non-LLM judges)
  duration_ms    Execution time in milliseconds
  timestamp      ISO 8601 timestamp

═══════════════════════════════════════════════════════════════

jq queries for trace analysis:

  # Quick pass/fail check
  jq -r 'select(.type=="summary") | .result' trace.jsonl

  # All steps with verdicts
  jq -r 'select(.type=="step") | "[\(.index)] attempt=\(.attempt) \(.judge_type) \(.judge_verdict): \(.judge_reason)"' trace.jsonl

  # Only failures
  jq 'select(.type=="step" and .judge_verdict=="FAIL")' trace.jsonl

  # Retry history for a specific step
  jq -r 'select(.type=="step" and .index==2) | "attempt \(.attempt): \(.judge_verdict) — \(.judge_reason)"' trace.jsonl

  # Full output of a specific step
  jq -r 'select(.type=="step" and .index==3) | .stdout' trace.jsonl

  # LLM's raw judgment
  jq -r 'select(.type=="step" and .index==0) | .judge_raw' trace.jsonl
