---
name: agentic-test-runner
description: |
  LLM-judged CLI test runner. Define test specs in YAML, execute commands in a
  persistent shell, let an LLM judge PASS/FAIL. Use when testing CLI tools,
  verifying agent workflows, or running regression tests. Outputs JSONL trace.
---

# agentic-test-runner

Write YAML test specs, run them with `atest`, read the JSONL trace.

## Install

```bash
npm install -g agentic-test-runner
```

## When to use

- Testing CLI tools (version output, command flags, error handling)
- Verifying agent workflows end-to-end
- Regression testing after code changes
- Any scenario where you need to verify CLI behavior but writing assertion code is too slow

## How to write a test spec

Create a YAML file. Each spec has a name, optional setup/teardown, and a list of steps.

### Minimal example

```yaml
name: "My CLI test"
steps:
  - command: "my-tool --version"
    judge_prompt: "输出应包含版本号 x.y.z 格式"
  - command: "my-tool --help 2>&1 | head -20"
    judge_prompt: "应显示用法说明和至少 3 个选项"
```

### Full schema

```yaml
name: "test name"            # required
description: "what it tests"  # optional, given to LLM as context
setup:                        # optional, run before steps (not judged)
  - "rm -rf /tmp/workspace"
  - "mkdir -p /tmp/workspace"
teardown:                     # optional, always runs (even on FAIL)
  - "rm -rf /tmp/workspace"
steps:                        # required
  - command: "some command"   #   required, shell command
    judge_prompt: "criteria"  #   optional, see below
    timeout: 30               #   optional, seconds (default 30)
    retry:                    #   optional — retry config for async operations
      max: 3                  #     max retries (default: 3)
      interval: 10            #     seconds between retries (default: 10)
      backoff: false          #     false=fixed, true=exponential (default: false)
```

### Two types of steps

**Judged step** (has `judge_prompt`):
```yaml
- command: "echo hello"
  judge_prompt: "输出应包含 'hello'"
```
LLM reads the command output + judge_prompt and returns PASS/FAIL.

**Transition step** (no `judge_prompt`):
```yaml
- command: "cd /tmp/project"
- command: "mkdir -p build"
```
Auto-judged by exit code: 0 = PASS, non-zero = FAIL. No LLM call, saves tokens and time.

Use transition steps for setup-like actions within the test flow (cd, mkdir, file creation) that don't need semantic judgment.

### Retry / async steps

Some operations are async — a service starting up, a resource being created. Instead of guessing `sleep N`, configure `retry` and let the step poll until ready.

**How it works:**

| Has `judge_prompt` | Has `retry` | RETRY triggered by | LLM call? |
|:-:|:-:|---|:-:|
| ✅ | ✅ | LLM returns `VERDICT: RETRY` | ✅ |
| ✅ | ❌ | N/A (PASS/FAIL only) | ✅ |
| ❌ | ✅ | exit code non-zero | ❌ |
| ❌ | ❌ | N/A (PASS/FAIL only) | ❌ |

**Transition step with retry** (no LLM — pure polling):
```yaml
- command: "curl -sf http://localhost:8080/health"
  retry:
    max: 10
    interval: 5
    backoff: false
```
Exit 0 = PASS, non-zero = RETRY. Tries every 5s, up to 10 retries.

**Judged step with retry** (LLM distinguishes "not ready" vs "broken"):
```yaml
- command: "curl -s http://localhost:8080/api/status | jq -r '.state'"
  judge_prompt: "输出应为 'running' 或 'healthy'"
  retry:
    max: 5
    interval: 10
    backoff: true    # 10s → 20s → 40s → 80s → 160s
```
LLM sees `"starting"` → RETRY. Sees `"error"` → FAIL. Only PASS when output clearly meets criteria.

**When retry is exhausted:** RETRY converts to FAIL. `max` is the number of retries (not counting the first try).

**Backoff:** `false` = fixed interval. `true` = exponential (`interval × 2^attempt`).

### Writing good judge_prompts

```yaml
# GOOD — specific, verifiable
judge_prompt: "输出应包含版本号，格式为 x.y.z"
judge_prompt: "exit code 应为 1，输出应包含 'Error: not found'"
judge_prompt: "输出应为 JSON 数组，包含至少 2 个元素，每个有 id 和 name"
judge_prompt: "应列出至少 3 个 workflow"

# BAD — vague, not verifiable
judge_prompt: "看起来正常"
judge_prompt: "应该工作"
```

Rules:
- Use concrete verbs: "应包含 / 应为 / 应返回 / 应列出"
- Specify exact format (JSON, version number, line count)
- Can reference exit code — it's shown as `[exit: N]` to the LLM
- Can reference previous step outputs — LLM sees full execution history

### ⚠️ Control output size

The LLM judge sees **all previous step outputs** in its context. A step that outputs 500 lines will blow up the context for every subsequent step.

**Always trim command output. Keep only what the judge needs:**

```yaml
# GOOD — trimmed
- command: "npm test 2>&1 | tail -20"
  judge_prompt: "输出应包含 'all tests passed'"
- command: "curl -s http://localhost:8080/health | jq '.status'"
  judge_prompt: "输出应为 up 或 healthy"
- command: "ls -la | head -20"
  judge_prompt: "应列出至少 5 个文件"

# BAD — untrimmed, could be hundreds of lines
- command: "npm test"
  judge_prompt: "所有测试通过"
- command: "cat huge-config.json"
  judge_prompt: "配置正确"
```

| Technique | Example |
|-----------|---------|
| Limit lines | `cmd \| head -20` |
| Show tail only | `cmd 2>&1 \| tail -20` |
| Extract field | `curl -s /api \| jq '.status'` |
| Grep specific | `cmd \| grep -oE '[0-9]+\.[0-9]+\.[0-9]+'` |
| Merge stdout+stderr | `cmd 2>&1 \| head -30` |

### Persistent shell

Steps run in a single bash process. `cd` and `export` persist across steps:

```yaml
steps:
  - command: "cd /tmp && mkdir proj && cd proj"
    # transition step, no judge_prompt
  - command: "pwd"
    judge_prompt: "输出应包含 /tmp/proj"
  - command: "echo 'data' > config.txt"
    # transition step
  - command: "cat config.txt"
    judge_prompt: "输出应包含 'data'"
```

### No hardcoded absolute paths

Specs should be machine-independent. Use `cwd` (relative to spec file location) or `cd` in transition steps. Do not use absolute paths like `/home/user/project`.

```yaml
# Using cwd field — relative to spec file
cwd: ./test-workspace
setup:
  - "mkdir -p fixtures"
steps:
  - command: "ls fixtures"
    judge_prompt: "应列出至少 1 个文件"

# Or cd in a transition step
steps:
  - command: "cd ./test-workspace"   # transition step
  - command: "pwd"
    judge_prompt: "输出应包含 test-workspace"
```

## How to run atest

### Prerequisites

Set LLM config via environment variables (required only for steps with `judge_prompt`):

```bash
export ATEST_API_KEY=sk-xxx
export ATEST_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
export ATEST_MODEL=glm-5.2
```

Or pass via CLI flags (overrides env vars):

```bash
atest run spec.yaml --api-key sk-xxx --base-url https://... --model glm-5.2
```

### Commands

```bash
# Run test with LLM judgment
atest run my-test.yaml

# Specify trace output path
atest run my-test.yaml -o /tmp/trace.jsonl

# Replay a trace as human-readable output
atest show my-test-20260723-120000.jsonl

# Disable trace file
atest run my-test.yaml --no-trace
```

### Exit code

- `0` — all steps PASS
- `1` — at least one step FAILED

### stdout output

stdout is brief — command, exit code, verdict, one-line reason:

```
🧪 atest — LLM-judged CLI test runner
   Case: My CLI test
   Steps: 3
   Judge: glm-5.2 @ https://...

━━━ Step 1/3 ━━━
  $ my-tool --version
  1.2.3
  [exit: 0]
  ✅ PASS: The output contains version number 1.2.3.

━━━ Summary ━━━
✅ All 3 steps passed!
📊 Trace: my-test-20260723-120000.jsonl
```

### Workflow

1. **Write spec** — create YAML file with steps
2. **Run with LLM** — `atest run spec.yaml` (ensure ATEST_API_KEY is set)
3. **Check trace** — read the JSONL file for detailed results
4. **Iterate** — fix failures, re-run

## How to read the trace

Every run writes a JSONL trace file (one JSON object per line). Default path: `<spec-stem>-<timestamp>.jsonl` in the current directory.

### Structure

```
meta       ← test metadata (name, model, start time)
setup      ← setup command records (one per command)
step       ← test step records (one per attempt; retries have same index, different attempt)
teardown   ← teardown command records
summary    ← final result (pass/fail/retried counts, duration)
```

### Key fields in step records

| Field | Meaning |
|-------|---------|
| `index` | Step number (0-based) |
| `attempt` | Retry attempt (0 = first try, 1+ = retries) |
| `command` | Shell command executed |
| `stdout` | Full command output (not truncated in trace) |
| `exit_code` | Process exit code |
| `timed_out` | Whether the step timed out |
| `cwd` | Working directory when step executed (after any cd in prior steps) |
| `judge_prompt` | Criteria given to LLM (null for transition steps) |
| `judge_verdict` | `PASS`, `FAIL`, or `RETRY` |
| `judge_reason` | One-line explanation |
| `judge_raw` | Full raw LLM response (null for transition steps) |
| `judge_method` | `llm` (LLM judged) or `exit_code` (auto-judged transition) |
| `duration_ms` | Execution time in milliseconds |
| `timestamp` | ISO 8601 timestamp when step completed |

### Querying trace

```bash
# Replay as human-readable (same stdout as run)
atest show my-test-*.jsonl

# Quick pass/fail check
jq -r 'select(.type=="summary") | .result' trace.jsonl

# Show all steps with verdicts
jq -r 'select(.type=="step") | "[\(.index)] attempt=\(.attempt) \(.judge_method) \(.judge_verdict): \(.judge_reason)"' trace.jsonl

# Show only failures
jq 'select(.type=="step" and .judge_verdict=="FAIL")' trace.jsonl

# Show retry history for a specific step
jq -r 'select(.type=="step" and .index==2) | "attempt \(.attempt): \(.judge_verdict) — \(.judge_reason)"' trace.jsonl

# Show full output of a specific step
jq -r 'select(.type=="step" and .index==3) | .stdout' trace.jsonl

# Show LLM's raw judgment for a step
jq -r 'select(.type=="step" and .index==0) | .judge_raw' trace.jsonl

# Timeline of all events
jq -r '"\(.timestamp) \(.type) \(.command // "")"' trace.jsonl
```

## Pitfalls

1. **Output explosion** — a single `npm test` or `cat huge.json` can output hundreds of lines. The LLM context includes ALL previous step outputs. Always trim with `head`, `tail`, `grep`, or `jq`.

2. **Failing transition steps** — if a transition step (no judge_prompt) returns non-zero, it FAILs immediately unless `retry` is configured. Make sure setup commands succeed.

3. **FAIL stops everything** — when a step FAILs, subsequent steps are not executed. Teardown still runs.

4. **Timeout** — `timeout` limits the command execution itself, NOT the total retry time. A step with `timeout: 5` and `retry: { max: 10, interval: 10 }` can take up to 5+10×10=105s total.

5. **Machine-dependent specs** — don't hardcode absolute paths in the spec. Use `cd` in a setup/transition step. The spec should work on any machine.

6. **Quote carefully** — use `printf` instead of `echo` for multi-line output. Single-quoted `\n` is literal, not a newline.

7. **Don't use `exit` in commands** — `exit N` in a `{ }` block kills the persistent shell. Use `false` or `()` subshell instead: `test -f file || (touch file; false)`.
