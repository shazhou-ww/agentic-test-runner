# atest — 让 Agent 写 CLI 测试像写 YAML 一样简单

Define test cases in YAML. Execute commands in a persistent shell. Let an LLM judge PASS/FAIL. Get a JSONL trace. Replay traces anytime.

## 解决什么问题

Agent 经常需要验证 CLI 工具的行为：版本输出对不对、命令组合有没有按预期工作、错误处理合不合理。传统做法是写 assertion 代码——解析输出、匹配字符串、处理边界条件——一个测试用例可能要 50 行代码，Agent 写起来慢，维护更慢。

**atest** 把这件事压缩成三步：

1. **写 YAML** — 每个步骤一条命令 + 一句自然语言描述预期结果
2. **跑 `atest run`** — 命令在持久 shell 中执行，LLM 读输出做判定（PASS/FAIL）
3. **看 trace** — JSONL 记录全量数据，可回放、可查询

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

不需要写解析逻辑，不需要正则匹配，不需要断言库。LLM 直接读命令输出做语义判定——它看得懂"版本号格式对不对"，比正则灵活得多。

**核心设计**：

- **持久 shell** — 步骤间共享状态（`cd`、`export`、文件操作都保留），模拟真实工作流
- **两种步骤** — 有 `judge_prompt` 的走 LLM 判定；没有的走 exit code 自动判定（省 token）
- **trace 回放** — `atest show trace.jsonl` 完整复现运行时输出，不重跑命令
- **FAIL 即停** — 一步失败后续不执行，teardown 照跑，不会把系统搞坏

## Agent 如何快速上手

### 1. 安装

```bash
npm install -g agentic-test-runner
```

命令名是 `atest`，需要 Node.js ≥18。

### 2. 配 LLM

atest 支持任何 OpenAI 兼容 API，三个环境变量：

```bash
export ATEST_API_KEY=sk-xxx
export ATEST_BASE_URL=https://api.openai.com/v1   # 或任何兼容端点
export ATEST_MODEL=gpt-4o                          # 或 glm-5.2 / claude-3.5 等
```

纯 transition step（无 `judge_prompt`）不需要 LLM 配置。

### 3. 加载 Skill

atest 的完整使用指南（YAML schema、judge_prompt 写法、trace 结构、pitfalls）打包在 repo 里的 skill 目录：

```
shazhou-ww/agentic-test-runner → skill/agentic-test-runner/SKILL.md
```

Agent 将这个路径加入 skill 加载列表即可。Skill 内容覆盖：

- 完整 YAML schema 和字段说明
- judge_prompt 的好/坏示例
- 输出裁剪技巧（防止 LLM context 爆炸）
- trace JSONL 结构和 jq 查询示例
- 常见 pitfalls

### 4. 开跑

```bash
atest run my-test.yaml                    # 跑测试，输出到 stdout + trace
atest show my-test-*.jsonl                # 回放 trace
```

exit code 0 = 全过，1 = 有失败。

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
