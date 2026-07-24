atest run — execute a test spec

Usage: atest run <spec.yaml> [options]

Options:
  --api-key <key>       LLM API key (or ATEST_API_KEY env)
  --base-url <url>      LLM endpoint (or ATEST_BASE_URL env)
  --model <name>        Model name (or ATEST_MODEL env, required for llm judge)
  -o, --output <path>   JSONL trace path (default: <stem>-<timestamp>.jsonl)
  --no-trace            Disable trace output
  -h, --help            Show this help

Environment:
  ATEST_API_KEY         LLM API key
  ATEST_BASE_URL        LLM API endpoint
  ATEST_MODEL           LLM model name (required for judge type: llm)
CLI flags override environment variables.
Config file (~/.config/atest/config.yaml) provides defaults.
Run "atest config" to see effective values and sources.

═══════════════════════════════════════════════════════════════

Spec format (YAML):

  name: "test name"             # required
  description: "what it tests"  # optional, given to LLM as context
  cwd: ./workdir                 # optional, working dir (relative to spec file)
  setup:                         # optional, run before steps (not judged)
    - "mkdir -p /tmp/work"
  teardown:                      # optional, always runs (even on FAIL)
    - "rm -rf /tmp/work"
  steps:                         # required
    - command: "some command"   #   required, shell command
      judge:                     #   optional — omit for transition step
        type: llm                #     llm | regex | jsonata
        prompt: "criteria"      #     llm: natural language prompt
        # expr: "pattern"       #     regex/jsonata: expression
      timeout: 30                #   optional, seconds (default 30)
      retry:                     #   optional — retry for async ops
        max: 3                   #     max retries, not counting first try (default 3)
        interval: 10             #     seconds between retries (default 10)
        backoff: false           #     false=fixed, true=exponential (default false)

═══════════════════════════════════════════════════════════════

Judge types:

  type: llm — LLM reads stdout+stderr+exit_code, judges against prompt.
              Returns PASS/FAIL/RETRY. Most flexible, costs tokens.
    judge: { type: llm, prompt: "输出应包含版本号，格式为 x.y.z" }

  type: regex — Regex matched against stdout (trimmed). Match = PASS. No LLM cost.
    judge: { type: regex, expr: "[0-9]+\\.[0-9]+\\.[0-9]+" }

  type: jsonata — JSONata expression on {stdout, stderr, exit_code}. Truthy = PASS.
    judge: { type: jsonata, expr: "$json(stdout).status = 'healthy' and exit_code = 0" }

  (omit judge) — Transition step. Exit 0 = PASS, non-zero = FAIL. No LLM call.
    - command: "cd /tmp/project"
    - command: "mkdir -p build"

Decision guide:
  Need semantic judgment?           → llm
  Pattern matching on stdout?       → regex
  Extract/validate structured data? → jsonata
  Just cd/mkdir/setup?              → omit judge

═══════════════════════════════════════════════════════════════

Retry / async steps:

When retry is configured, RETRY verdicts re-execute after waiting.

  Judge type     | retry? | RETRY triggered by           | LLM?
  llm            | yes    | LLM returns VERDICT: RETRY    | yes
  regex/jsonata  | yes    | expression false → auto-RETRY | no
  none (trans.)  | yes    | exit code non-zero            | no

Without retry: PASS/FAIL only, no RETRY.
When retry exhausted: RETRY → FAIL.

Example — polling a service (no LLM, pure retry):
  - command: "curl -sf http://localhost:8080/health"
    retry: { max: 10, interval: 5 }

Example — LLM judge with retry (distinguishes "not ready" vs "broken"):
  - command: "curl -s http://localhost:8080/api/status"
    judge: { type: llm, prompt: "输出应为 running 或 healthy" }
    retry: { max: 5, interval: 10, backoff: true }

═══════════════════════════════════════════════════════════════

Writing good LLM judge prompts:

  GOOD — specific, verifiable:
    "输出应包含版本号，格式为 x.y.z"
    "exit code 应为 1，输出应包含 'Error: not found'"
    "输出应为 JSON 数组，包含至少 2 个元素，每个有 id 和 name"

  BAD — vague:
    "看起来正常"
    "应该工作"

  Rules:
  - Use concrete verbs: 应包含 / 应为 / 应返回
  - Specify exact format (JSON, version, count)
  - Can reference exit code (shown as [exit: N] to LLM)
  - LLM sees all prior step outputs — trim to avoid context explosion

  Trim techniques:
    cmd | head -20              # limit lines
    cmd 2>&1 | tail -20         # show tail only
    curl -s /api | jq '.status' # extract field
    cmd | grep -oE 'pattern'    # grep specific

═══════════════════════════════════════════════════════════════

Persistent shell:

Steps run in a single bash process. cd and export persist across steps:

  steps:
    - command: "cd /tmp && mkdir proj && cd proj"   # transition
    - command: "pwd"
      judge: { type: regex, expr: "/tmp/proj" }
    - command: "echo 'data' > config.txt"             # transition
    - command: "cat config.txt"
      judge: { type: regex, expr: "data" }

═══════════════════════════════════════════════════════════════

Pitfalls:

1. Output explosion — LLM judge sees ALL prior step outputs. Always trim:
   GOOD: "npm test 2>&1 | tail -20"
   BAD:  "npm test"

2. FAIL stops everything — subsequent steps not executed. Teardown still runs.

3. Don't use exit in commands — `exit N` kills the persistent shell.
   Use `false` or subshell: test -f file || (touch file; false)

4. Timeout limits command execution, not total retry time.
   timeout:5 + retry:{max:10,interval:10} = up to 105s total.

5. Don't hardcode absolute paths — use cwd field or cd in transition steps.
   Specs should be machine-independent.
