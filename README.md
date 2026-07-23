# atest — 让 Agent 帮你回归 CLI 测试

用 YAML 定义测试规格，在持久 shell 中执行命令，让 LLM 判定 PASS/FAIL。生成 JSONL trace，随时回放。

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
2. **你 review spec** — judge_prompt 够不够具体？命令验的到不到位？覆盖面够不够？
3. **Agent 跑 `atest run`** — 持久 shell 执行，LLM 读输出判 PASS/FAIL
4. **你 review trace** — JSONL 记录全量数据，命令、输出、判定理由、时间线，一目了然

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
2. 从 https://github.com/shazhou-ww/agentic-test-runner 安装 skill（路径：skill/agentic-test-runner/SKILL.md）
3. 学习完成后告诉我，你准备好怎么帮我用 atest 做 CLI 回归测试。
```

Agent 会自行完成安装和配置，然后告诉你接下来可以怎么协作。你负责两轮 review：先看 spec 写得好不好，跑完看 trace 确认结果。

---

## Spec 长什么样

你 review agent 写的 YAML 时，会看到这些字段：

```yaml
name: "test case name"          # 必填
description: "what this tests"  # 可选，给 LLM 的上下文

cwd: ./workspace                # 可选，相对 spec 文件的位置

setup:                          # 可选，步骤前执行（不判定）
  - "mkdir -p /tmp/workspace"
teardown:                       # 可选，总是执行（即使 FAIL）
  - "rm -rf /tmp/workspace"

steps:                          # 必填
  - command: "some command"     #   必填，shell 命令
    judge_prompt: "expected"    #   可选 — 不写就按 exit code 判（0=PASS）
    timeout: 30                 #   可选，秒（默认 30）
    retry:                      #   可选 — 异步重试
      max: 3                    #     最多重试几次（默认 3）
      interval: 10              #     每次等几秒（默认 10）
      backoff: false            #     false=固定间隔, true=指数退避
```

### 两种 step

**有 judge_prompt** — LLM 读输出做语义判定。这是 review 重点：prompt 够不够具体？

```yaml
# ✅ 好 — 具体、可验证
judge_prompt: "输出应包含版本号，格式为 x.y.z"
judge_prompt: "exit code 应为 1，输出应包含 'Error: not found'"

# ❌ 差 — 模糊
judge_prompt: "看起来正常"
```

**没有 judge_prompt**（transition step）— 纯 exit code 判定，0=PASS 非0=FAIL。用于 cd、mkdir 等不需要语义判断的步骤。

### retry

异步操作（服务启动等）不用猜 `sleep N`，配 retry 让 step 轮询：

```yaml
- command: "curl -sf http://localhost:8080/health"
  retry:
    max: 10
    interval: 5
```

有 judge_prompt + retry 时，LLM 可以返回 RETRY（"还没就绪，再等等"）而不是直接 FAIL。

### ⚠️ 输出裁剪

LLM 会看到**所有前序步骤的输出**。一条 `npm test` 输出几百行会撑爆 context。review 时注意命令有没有裁剪：

```yaml
# ✅ 好 — 裁剪过
- command: "npm test 2>&1 | tail -20"
  judge_prompt: "输出应包含 'all tests passed'"

# ❌ 差 — 原始输出
- command: "npm test"
  judge_prompt: "所有测试通过"
```

## 怎么跑

agent 通常会帮你跑，但你想自己跑也简单：

```bash
atest run my-test.yaml                    # 跑测试
atest show my-test-*.jsonl                # 回放 trace
```

exit code 0 = 全过，1 = 有失败。LLM 配置（API key 等）agent 会处理好。

## 怎么看 trace

每次跑都会生成一个 JSONL trace 文件。stdout 是简版，trace 是完整记录。

**stdout 示例：**
```
🧪 atest — LLM-judged CLI test runner
   Case: Basic checks
   Steps: 4
   Judge: glm-5.2 @ https://...

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

**用 jq 查 trace：**

```bash
# 总结果
jq -r 'select(.type=="summary") | .result' my-test-*.jsonl

# 所有 step 的判定
jq -r 'select(.type=="step") | "[\(.index)] attempt=\(.attempt) \(.judge_verdict): \(.judge_reason)"' my-test-*.jsonl

# 只看失败的
jq 'select(.type=="step" and .judge_verdict=="FAIL")' my-test-*.jsonl

# 看某一步的完整输出
jq -r 'select(.type=="step" and .index==3) | .stdout' my-test-*.jsonl

# 看 retry 历史
jq -r 'select(.type=="step" and .index==2) | "attempt \(.attempt): \(.judge_verdict) — \(.judge_reason)"' my-test-*.jsonl

# 回放成人类可读格式
atest show my-test-*.jsonl
```

## License

MIT
