# atest — LLM-judged CLI test runner

Define test cases in YAML. Execute commands in a persistent shell. Let an LLM judge PASS/FAIL. Get a JSONL trace. Replay traces anytime.

## Install

```bash
npm install -g agentic-test-runner
```

## Quick start

```yaml
# my-test.yaml
name: "Basic checks"
description: "Verify CLI outputs"
setup:
  - "rm -rf /tmp/demo"
  - "mkdir -p /tmp/demo"
steps:
  - command: "echo hello world"
    judge_prompt: "输出应包含 'hello world'"
    timeout: 5
  - command: "cd /tmp/demo"
  - command: "pwd"
    judge_prompt: "输出应包含 /tmp/demo"
  - command: "rm -rf /tmp/demo"
teardown:
  - "rm -rf /tmp/demo"
```

```bash
# Set LLM config
export ATEST_API_KEY=sk-xxx
export ATEST_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
export ATEST_MODEL=glm-5.2

# Run
atest run my-test.yaml

# Replay a trace as human-readable output
atest show my-test-20260723-120000.jsonl
```

## Subcommands

| Command | Description |
|---------|-------------|
| `atest run <spec.yaml> [options]` | Execute spec, judge with LLM, write trace |
| `atest show <trace.jsonl>` | Replay trace as human-readable stdout |
| `atest -V, --version` | Print version |
| `atest -h, --help` | Show help |
| `atest run -h` | Show run options |
| `atest show -h` | Show show usage |

## Output

**stdout** — brief, human-readable (same for `run` and `show`):
```
🧪 atest — LLM-judged CLI test runner
   Case: Basic checks
   Steps: 4
   Judge: glm-5.2 @ https://...

  [setup] $ rm -rf /tmp/demo
  [setup] $ mkdir -p /tmp/demo

━━━ Step 1/4 ━━━
  $ echo hello world
  hello world
  [exit: 0]
  ✅ PASS: ...

━━━ Step 2/4 ━━━
  $ cd /tmp/demo
  [exit: 0]
  ✅ PASS: exit code 0 (transition step)

━━━ Summary ━━━
✅ All 4 steps passed!
📊 Trace: my-test-20260723-120000.jsonl
```

**trace file** — verbose JSONL, one JSON object per line. Every line has a `timestamp`.

Query with `jq`:
```bash
# Check result
jq -r 'select(.type=="summary") | .result' my-test-*.jsonl

# Show failed steps
jq 'select(.type=="step" and .judge_verdict=="FAIL")' my-test-*.jsonl

# Show per-step cwd
jq -r 'select(.type=="step") | "[\(.index)] \(.cwd) $ \(.command)"' my-test-*.jsonl

# Replay as human-readable
atest show my-test-20260723-120000.jsonl
```

## YAML schema

```yaml
name: "test case name"          # required
description: "what this tests"  # optional

cwd: ./workspace                # optional, relative to spec file location

setup:                          # optional, run before steps (not judged)
  - "mkdir -p /tmp/workspace"
teardown:                       # optional, always runs (even on FAIL)
  - "rm -rf /tmp/workspace"

steps:                          # required, TestStep[]
  - command: "some command"     #   required, shell command
    judge_prompt: "expected"    #   optional — if omitted, auto-judge by exit code
    timeout: 30                 #   optional, seconds (default: 30)
```

### Two types of steps

**Judged step** (has `judge_prompt`):
```yaml
- command: "echo hello"
  judge_prompt: "输出应包含 'hello'"
```
LLM reads the output + judge_prompt and returns PASS/FAIL.

**Transition step** (no `judge_prompt`):
```yaml
- command: "cd /tmp/project"
- command: "mkdir -p build"
```
Auto-judged by exit code: 0 = PASS, non-zero = FAIL. No LLM call needed.

### judge_prompt tips

```yaml
# ✅ Good — specific, verifiable
judge_prompt: "输出应包含版本号，格式为 x.y.z"
judge_prompt: "exit code 应为 1，输出应包含 'Error: not found'"
judge_prompt: "输出应为 JSON 数组，包含至少 2 个元素"

# ❌ Bad — vague
judge_prompt: "看起来正常"
judge_prompt: "应该工作"
```

### Control output size

The LLM judge sees **all previous step outputs**. Trim long outputs:

```yaml
# ✅ Good — trimmed
- command: "npm test 2>&1 | tail -20"
  judge_prompt: "输出应包含 'all tests passed'"
- command: "curl -s http://localhost:8080/health | jq '.status'"
  judge_prompt: "输出应为 up 或 healthy"

# ❌ Bad — untrimmed
- command: "npm test"
  judge_prompt: "所有测试通过"
```

## CLI options (run)

| Option | Description | Default |
|--------|-------------|---------|
| `--api-key <key>` | LLM API key (or `ATEST_API_KEY` env) | env |
| `--base-url <url>` | LLM endpoint (or `ATEST_BASE_URL` env) | env |
| `--model <name>` | Model name (or `ATEST_MODEL` env) | env |
| `-o, --output <path>` | JSONL trace path | `<stem>-<timestamp>.jsonl` |
| `--no-trace` | Disable trace file | enabled |

## Environment variables

| Variable | Description |
|----------|-------------|
| `ATEST_API_KEY` | LLM API key |
| `ATEST_BASE_URL` | LLM API endpoint |
| `ATEST_MODEL` | LLM model name |

CLI flags override environment variables. All three are required when LLM judgment is needed (steps with `judge_prompt`). Transition steps don't need LLM config.

## License

MIT
