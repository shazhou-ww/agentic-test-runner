# atest — 让 Agent 帮你回归 CLI 测试

Define test cases in YAML. Execute commands in a persistent shell. Let an LLM judge PASS/FAIL. Get a JSONL trace. Replay traces anytime.

## 解决什么问题

你在开发给 Agent 用的 CLI 工具。每次改完代码，要验证有没有改坏东西：

- **手工回归太慢** — 每条命令手动跑、手动看输出，改一次验半天
- **让 Agent 回归不稳定** — Agent 跑完一轮说"看起来正常"，但你不确定它真验了什么、验到什么程度
- **回归过程不好审计** — 出了问题回头查，没有记录，只有 Agent 的一句"通过了"

**atest** 让 Agent 自己写 YAML 测试规格、自己跑、自己判。你只需要 review 规格合不合理，然后看 trace 确认结果。

```
你：写个测试规格，验一下 my-tool 的 --version 和 --help
Agent：写 YAML → atest run → 全过
你：看一眼 trace → judge_prompt 写得对 → 放行
```

工作流变成：

1. **Agent 写 YAML** — 每步一条命令 + 一句自然语言描述预期
2. **Agent 跑 `atest run`** — 持久 shell 执行，LLM 读输出判 PASS/FAIL
3. **你 review trace** — JSONL 记录全量数据，命令、输出、判定理由、时间线，一目了然

```yaml
name: "CLI 冒烟测试"
steps:
  - command: "my-tool --version"
    judge_prompt: "输出应包含版本号，格式为 x.y.z"
  - command: "my-tool --help 2>&1 | head -20"
    judge_prompt: "应显示用法说明和至少 3 个选项"
  - command: "my-tool invalid-flag"
    judge_prompt: "exit code 应为 1，输出应包含 'unknown flag'"
```

不需要写解析逻辑，不需要正则匹配，不需要断言库。LLM 直接读命令输出做语义判定。trace 就是审计记录。

**核心设计**：

- **持久 shell** — 步骤间共享状态（`cd`、`export`、文件操作都保留），模拟真实工作流
- **两种步骤** — 有 `judge_prompt` 的走 LLM 判定；没有的走 exit code 自动判定（省 token）
- **异步重试** — 配置 `retry` 后，判定可返回 RETRY 等待后重试，支持固定/指数退避
- **trace 回放** — `atest show trace.jsonl` 完整复现运行时输出，不重跑命令
- **FAIL 即停** — 一步失败后续不执行，teardown 照跑，不会把系统搞坏

## 快速上手

把下面这段发给你的 Agent：

```
安装 atest 并加载它的 skill：
1. npm install -g agentic-test-runner
2. 读取 https://github.com/shazhou-ww/agentic-test-runner/blob/main/skill/agentic-test-runner/SKILL.md 并按照其中的指南工作
3. 读取 https://github.com/shazhou-ww/agentic-test-runner/blob/main/README.md 了解完整 schema 和 CLI 用法

装好后告诉我，然后帮我写 CLI 测试规格。
```

Agent 会自行完成安装、配置 LLM 环境变量、加载 skill，然后等你给指令写 case。你只需要 review 它写的 YAML 和跑出来的 trace。

---

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

# Show retry history for a step
jq -r 'select(.type=="step" and .index==2) | "attempt \(.attempt): \(.judge_verdict) — \(.judge_reason)"' my-test-*.jsonl

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
    retry:                      #   optional — retry config for async operations
      max: 3                    #     max retries (default: 3)
      interval: 10              #     seconds between retries (default: 10)
      backoff: false            #     false=fixed, true=exponential (default: false)
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

### Retry / async steps

Some operations are async — a service might need time to start, a resource might be creating. Instead of guessing `sleep N`, configure `retry` and let the step poll until ready.

**How it works:**

| Has `judge_prompt` | Has `retry` | RETRY triggered by | LLM call? |
|:-:|:-:|---|:-:|
| ✅ | ✅ | LLM returns `VERDICT: RETRY` | ✅ |
| ✅ | ❌ | N/A (PASS/FAIL only) | ✅ |
| ❌ | ✅ | exit code non-zero | ❌ |
| ❌ | ❌ | N/A (PASS/FAIL only) | ❌ |

**Transition step with retry** (no LLM needed — pure polling):
```yaml
- command: "curl -sf http://localhost:8080/health"
  retry:
    max: 10
    interval: 5
    backoff: false
```
Tries every 5s, up to 10 retries. Exit 0 = PASS, non-zero = RETRY.

**Judged step with retry** (LLM can distinguish "not ready" vs "broken"):
```yaml
- command: "curl -s http://localhost:8080/api/status | jq -r '.state'"
  judge_prompt: "输出应为 'running' 或 'healthy'"
  retry:
    max: 5
    interval: 10
    backoff: true    # 10s → 20s → 40s → 80s → 160s
```
LLM sees output like `"starting"` → returns RETRY → wait → try again. If output is `"error"`, LLM returns FAIL immediately (not RETRY).

**Backoff:** `backoff: false` = fixed interval. `backoff: true` = exponential (`interval × 2^attempt`).

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
