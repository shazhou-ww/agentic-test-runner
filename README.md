# atest — LLM-judged CLI test runner

Define test cases in YAML. Execute commands in a persistent shell. Let an LLM judge PASS/FAIL. Get a JSONL trace.

## Install

```bash
npm install -g agentic-test-runner
```

## Quick start

```yaml
# my-test.yaml
name: "Basic checks"
description: "Verify CLI outputs"
cwd: /tmp
steps:
  - command: "echo hello world"
    judge_prompt: "输出应包含 'hello world'"
    timeout: 5
  - command: "mkdir demo && cd demo && pwd"
    judge_prompt: "输出应为 /tmp/demo"
  - command: "rm -rf /tmp/demo"
    judge_prompt: "无报错，清理成功"
```

```bash
# Set LLM config (or use --api-key / --base-url / --model)
export ATEST_API_KEY=sk-xxx
export ATEST_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
export ATEST_MODEL=glm-5.2

# Run
atest my-test.yaml

# Dry run (execute commands only, no LLM)
atest my-test.yaml --dry-run

# Specify trace output path
atest my-test.yaml -o /tmp/trace.jsonl

# Disable trace file
atest my-test.yaml --no-trace
```

## Output

**stdout** — brief, human-readable progress:
```
🧪 atest — LLM-judged CLI test runner
   Case: Basic checks
   Steps: 3
   Judge: glm-5.2 @ https://...

━━━ Step 1/3 ━━━
  $ echo hello world
  hello world
  [exit: 0]
  ✅ PASS: ...

━━━ Summary ━━━
✅ All 3 steps passed!
📊 Trace: my-test-20260723-120000.jsonl
```

**trace file** — verbose JSONL, one JSON object per line:
```jsonl
{"type":"meta","name":"...","model":"...","total_steps":3,"started_at":"..."}
{"type":"step","index":0,"command":"echo hello","stdout":"hello\n","exit_code":0,"judge_verdict":"PASS","judge_reason":"...","judge_raw":"VERDICT: PASS\nREASON: ...","duration_ms":52}
{"type":"summary","passed":3,"failed":0,"result":"PASS","duration_ms":1234,"ended_at":"..."}
```

Query with `jq`:
```bash
# Check result
jq -r 'select(.type=="summary") | .result' my-test-*.jsonl

# Show failed steps
jq 'select(.type=="step" and .judge_verdict=="FAIL")' my-test-*.jsonl

# Show judge reasoning
jq -r 'select(.type=="step") | "[\(.index)] \(.judge_verdict): \(.judge_reason)"' my-test-*.jsonl
```

## YAML schema

```yaml
name: "test case name"          # required
description: "what this tests"  # optional

cwd: /tmp                       # optional, working directory

setup:                          # optional, run before steps (not judged)
  - "mkdir -p /tmp/workspace"
teardown:                       # optional, run after steps (always runs)
  - "rm -rf /tmp/workspace"

steps:                          # required, TestStep[]
  - command: "some command"     #   required, shell command to execute
    judge_prompt: "expected"    #   required, criteria for LLM to judge
    timeout: 30                 #   optional, seconds (default: 30)
```

### judge_prompt tips

```yaml
# ✅ Good — clear, verifiable
judge_prompt: "输出应包含版本号，格式为 x.y.z"
judge_prompt: "exit code 应为 0，且 stderr 无错误信息"
judge_prompt: "输出应为 JSON 数组，包含至少 2 个元素"

# ❌ Bad — vague, not verifiable
judge_prompt: "看起来正常"
judge_prompt: "应该工作"
```

### Controlling output size

The LLM judge sees **all previous step outputs**. Trim long outputs to avoid context overflow:

```yaml
# ✅ Good — trimmed
- command: "npm test 2>&1 | tail -20"
  judge_prompt: "输出应包含 'all tests passed'"

- command: "curl -s http://localhost:8080/health | jq '.status'"
  judge_prompt: "输出应为 up 或 healthy"

# ❌ Bad — untrimmed, could be hundreds of lines
- command: "npm test"
  judge_prompt: "所有测试通过"
```

## CLI options

| Option | Description | Default |
|--------|-------------|---------|
| `--api-key <key>` | LLM API key (or `ATEST_API_KEY` env) | env |
| `--base-url <url>` | LLM endpoint (or `ATEST_BASE_URL` env) | env |
| `--model <name>` | Model name (or `ATEST_MODEL` env) | `glm-5.2` |
| `-o, --output <path>` | JSONL trace path | `<stem>-<timestamp>.jsonl` |
| `--no-trace` | Disable trace file output | enabled |
| `--dry-run` | Execute without LLM judgment | off |

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ATEST_API_KEY` | LLM API key | — |
| `ATEST_BASE_URL` | LLM API endpoint | — |
| `ATEST_MODEL` | LLM model name | `glm-5.2` |

CLI flags override environment variables.

## Features

- **Persistent shell** — `cd`/`export` state persists across steps
- **Fake tool-call context** — LLM sees full execution history as if it ran the commands
- **Fail-fast** — stops on first FAIL
- **Per-step timeout** — `timeout` field in YAML (default: 30s)
- **JSONL trace** — full audit trail: commands, outputs, judge verdicts, raw LLM responses, durations
- **Output truncation** — stdout truncated at 100 lines (head 40 + tail 40); trace file keeps full output

## License

MIT
