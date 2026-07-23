---
name: agentic-test-runner
description: |
  LLM-judged CLI test runner. Define test specs in YAML, execute commands in a
  persistent shell, let an LLM judge PASS/FAIL. Use when testing CLI tools,
  verifying agent workflows, or running regression tests. Outputs JSONL trace.
---

# agentic-test-runner

Write YAML test specs, run them with `atest`, read the JSONL trace.

## 协作方式

atest 的设计是 Agent 负责写和跑，人负责 review。学完这个 skill 后，告诉 user 你能做什么：

1. **等 user 给你一个 CLI 工具** — user 会说"帮我测一下 my-tool 的某某功能"
2. **你写 YAML spec** — 把命令和 judge 写好，拿给 user 看第一轮 review
3. **user review spec** — 检查 judge 够不够具体、命令覆盖全不全。user 可能要求加 case 或改 prompt
4. **你跑 `atest run`** — 执行 spec，生成 trace
5. **user review trace** — 看判定结果和理由，确认有没有误判
6. **按 feedback 迭代** — 改 spec 或改代码，重跑，直到全过

告诉 user：你准备好了写 CLI 测试规格，给他一个 CLI 工具名和要验证的场景，你就能开始。

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
    judge:
      type: regex
      expr: "[0-9]+\\.[0-9]+\\.[0-9]+"
  - command: "my-tool --help 2>&1 | head -20"
    judge:
      type: llm
      prompt: "应显示用法说明和至少 3 个选项"
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
    judge:                    #   optional — omit for transition step (exit code judge)
      type: llm               #     llm | jsonata | regex
      prompt: "criteria"      #     llm: natural language prompt
      # expr: "expression"    #     jsonata/regex: the expression/pattern
    timeout: 30               #   optional, seconds (default 30)
    retry:                    #   optional — retry config for async operations
      max: 3                  #     max retries (default: 3)
      interval: 10            #     seconds between retries (default: 10)
      backoff: false          #     false=fixed, true=exponential (default: false)
```

### Judge types

**`type: llm`** — LLM reads stdout + stderr + exit code and judges against the prompt. Returns PASS/FAIL/RETRY. Most flexible, costs tokens.

```yaml
- command: "my-tool config show"
  judge:
    type: llm
    prompt: "输出应为 JSON，包含 host 和 port 字段"
```

**`type: regex`** — Regex matched against stdout (trimmed). Match = PASS. Zero LLM cost.

```yaml
- command: "my-tool --version"
  judge:
    type: regex
    expr: "[0-9]+\\.[0-9]+\\.[0-9]+"
```

**`type: jsonata`** — JSONata expression evaluated against `{ stdout, stderr, exit_code }`. Truthy = PASS. Most flexible deterministic judge.

```yaml
- command: "curl -s http://localhost:8080/api/status"
  judge:
    type: jsonata
    expr: "$json(stdout).status = 'healthy' and exit_code = 0"
```

**No `judge` field** (transition step) — Auto-judged by exit code: 0 = PASS, non-zero = FAIL. No LLM call. Use for cd, mkdir, file creation.

```yaml
- command: "cd /tmp/project"
- command: "mkdir -p build"
```

Use transition steps for setup-like actions within the test flow (cd, mkdir, file creation) that don't need semantic judgment.

### Retry / async steps

Some operations are async — a service starting up, a resource being created. Instead of guessing `sleep N`, configure `retry` and let the step poll until ready.

**How it works:**

| Judge type | Has `retry` | RETRY triggered by | LLM call? |
|:-:|:-:|---|:-:|
| `llm` | ✅ | LLM returns `VERDICT: RETRY` | ✅ |
| `llm` | ❌ | N/A (PASS/FAIL only) | ✅ |
| `regex`/`jsonata` | ✅ | expression false → auto-RETRY | ❌ |
| `regex`/`jsonata` | ❌ | N/A (PASS/FAIL only) | ❌ |
| none (transition) | ✅ | exit code non-zero | ❌ |
| none (transition) | ❌ | N/A (PASS/FAIL only) | ❌ |

**Transition step with retry** (no LLM — pure polling):
```yaml
- command: "curl -sf http://localhost:8080/health"
  retry:
    max: 10
    interval: 5
    backoff: false
```
Exit 0 = PASS, non-zero = RETRY. Tries every 5s, up to 10 retries.

**LLM judge with retry** (LLM distinguishes "not ready" vs "broken"):
```yaml
- command: "curl -s http://localhost:8080/api/status | jq -r '.state'"
  judge:
    type: llm
    prompt: "输出应为 'running' 或 'healthy'"
  retry:
    max: 5
    interval: 10
    backoff: true    # 10s → 20s → 40s → 80s → 160s
```
LLM sees `"starting"` → RETRY. Sees `"error"` → FAIL. Only PASS when output clearly meets criteria.

**Deterministic judge with retry** (regex/jsonata FAIL auto-converts to RETRY):
```yaml
- command: "curl -s http://localhost:8080/api/status"
  judge:
    type: jsonata
    expr: "$json(stdout).state = 'running'"
  retry:
    max: 5
    interval: 10
```
Expression false → RETRY. Can't distinguish "not ready" from "broken" — always retries until max.

**When retry is exhausted:** RETRY converts to FAIL. `max` is the number of retries (not counting the first try).

**Backoff:** `false` = fixed interval. `true` = exponential (`interval × 2^attempt`).

### Writing good LLM judge prompts

```yaml
# GOOD — specific, verifiable
judge:
  type: llm
  prompt: "输出应包含版本号，格式为 x.y.z"
judge:
  type: llm
  prompt: "exit code 应为 1，输出应包含 'Error: not found'"
judge:
  type: llm
  prompt: "输出应为 JSON 数组，包含至少 2 个元素，每个有 id 和 name"

# BAD — vague, not verifiable
judge:
  type: llm
  prompt: "看起来正常"
judge:
  type: llm
  prompt: "应该工作"
```

Rules:
- Use concrete verbs: "应包含 / 应为 / 应返回 / 应列出"
- Specify exact format (JSON, version number, line count)
- Can reference exit code — it's shown as `[exit: N]` to the LLM
- Can reference previous step outputs — LLM sees full execution history

### ⚠️ Control output size

The LLM judge sees **all previous step outputs** (stdout + stderr) in its context. A step that outputs 500 lines will blow up the context for every subsequent step.

**Always trim command output. Keep only what the judge needs:**

```yaml
# GOOD — trimmed
- command: "npm test 2>&1 | tail -20"
  judge:
    type: llm
    prompt: "输出应包含 'all tests passed'"
- command: "curl -s http://localhost:8080/health | jq '.status'"
  judge:
    type: llm
    prompt: "输出应为 up 或 healthy"
- command: "ls -la | head -20"
  judge:
    type: llm
    prompt: "应列出至少 5 个文件"

# BAD — untrimmed, could be hundreds of lines
- command: "npm test"
  judge:
    type: llm
    prompt: "所有测试通过"
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
    # transition step, no judge
  - command: "pwd"
    judge:
      type: regex
      expr: "/tmp/proj"
  - command: "echo 'data' > config.txt"
    # transition step
  - command: "cat config.txt"
    judge:
      type: regex
      expr: "data"
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
    judge:
      type: llm
      prompt: "应列出至少 1 个文件"

# Or cd in a transition step
steps:
  - command: "cd ./test-workspace"   # transition step
  - command: "pwd"
    judge:
      type: regex
      expr: "test-workspace"
```

## How to run atest

### Prerequisites

Set LLM config via environment variables (required only for steps with `judge type: llm`):

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

1. **Write spec** — create YAML file with steps and judge config
2. **Have user review spec** — check judge prompts/expressions and coverage
3. **Run** — `atest run spec.yaml` (ensure ATEST_API_KEY is set for `type: llm` steps)
4. **Have user review trace** — check verdicts and reasons
5. **Iterate** — fix spec or code, re-run

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
| `stdout` | Full command stdout (not truncated in trace) |
| `stderr` | Full command stderr |
| `exit_code` | Process exit code |
| `timed_out` | Whether the step timed out |
| `cwd` | Working directory when step executed (after any cd in prior steps) |
| `judge_type` | `llm`, `jsonata`, `regex`, or `exit_code` (transition step) |
| `judge_input` | The prompt (llm), expression (jsonata/regex), or null (exit_code) |
| `judge_verdict` | `PASS`, `FAIL`, or `RETRY` |
| `judge_reason` | One-line explanation |
| `judge_raw` | Full raw LLM response (null for non-LLM judges) |
| `duration_ms` | Execution time in milliseconds |
| `timestamp` | ISO 8601 timestamp when step completed |

### Querying trace

```bash
# Replay as human-readable (same stdout as run)
atest show my-test-*.jsonl

# Quick pass/fail check
jq -r 'select(.type=="summary") | .result' trace.jsonl

# Show all steps with verdicts
jq -r 'select(.type=="step") | "[\(.index)] attempt=\(.attempt) \(.judge_type) \(.judge_verdict): \(.judge_reason)"' trace.jsonl

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

2. **Failing transition steps** — if a transition step (no judge) returns non-zero, it FAILs immediately unless `retry` is configured. Make sure setup commands succeed.

3. **FAIL stops everything** — when a step FAILs, subsequent steps are not executed. Teardown still runs.

4. **Timeout** — `timeout` limits the command execution itself, NOT the total retry time. A step with `timeout: 5` and `retry: { max: 10, interval: 10 }` can take up to 5+10×10=105s total.

5. **Machine-dependent specs** — don't hardcode absolute paths in the spec. Use `cd` in a setup/transition step. The spec should work on any machine.

6. **Quote carefully** — use `printf` instead of `echo` for multi-line output. Single-quoted `\n` is literal, not a newline.

7. **Don't use `exit` in commands** — `exit N` in a `{ }` block kills the persistent shell. Use `false` or `()` subshell instead: `test -f file || (touch file; false)`.
