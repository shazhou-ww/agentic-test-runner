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
# Run with DashScope (GLM)
atest my-test.yaml --provider dashscope

# Dry run (no LLM, just execute commands)
atest my-test.yaml --dry-run

# Custom output path for trace
atest my-test.yaml --provider dashscope --output /tmp/trace.jsonl
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
  - command: "some command"     #   required
    judge_prompt: "expected"    #   required, criteria for LLM to judge
    timeout: 30                 #   optional, seconds (default: 30)
```

## CLI options

| Option | Description | Default |
|--------|-------------|---------|
| `--provider dashscope\|copilot` | Provider preset | none |
| `--api-key <key>` | LLM API key (or `JUDGE_API_KEY` env) | env |
| `--base-url <url>` | LLM endpoint (or `JUDGE_BASE_URL` env) | preset/env |
| `--model <name>` | Model name (or `JUDGE_MODEL` env) | `glm-5.2` |
| `--output <path>` | JSONL trace path | `<stem>.trace.jsonl` |
| `--no-trace` | Disable trace output | enabled |
| `--dry-run` | Execute without LLM judgment | off |
| `--verbose` | Print raw LLM responses | off |

## Provider presets

| Provider | Base URL | Model |
|----------|----------|-------|
| `dashscope` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `glm-5.2` |
| `copilot` | `http://127.0.0.1:4142/v1` | `claude-opus-4.6` |

## JSONL trace

Every run outputs a JSONL trace (one JSON object per line):

```jsonl
{"type":"meta","name":"...","model":"...","total_steps":3,"started_at":"..."}
{"type":"step","index":0,"command":"echo hello","stdout":"hello\n","exit_code":0,"judge_verdict":"PASS","judge_reason":"...","duration_ms":52}
{"type":"summary","passed":3,"failed":0,"result":"PASS","duration_ms":1234,"ended_at":"..."}
```

Query with `jq`:

```bash
# Check result
jq -r 'select(.type=="summary") | .result' test.trace.jsonl

# Show failed steps
jq 'select(.type=="step" and .judge_verdict=="FAIL")' test.trace.jsonl
```

## Why?

Testing CLI tools is tedious. Writing assertion code for every output is slow. **llmt** lets you describe expected behavior in plain language and lets an LLM judge if the output matches — decoupling execution from judgment.

- **Persistent shell** — `cd`/`export` state persists across steps
- **Fake tool-call context** — LLM sees the full execution history as if it ran the commands
- **Fail-fast** — stops on first FAIL
- **JSONL trace** — full audit trail of commands, outputs, and verdicts

## License

MIT
