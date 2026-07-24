atest {{version}} — LLM-judged CLI test runner

Write YAML spec → atest run → read JSONL trace.

Minimal spec:
  name: "version check"
  steps:
    - command: "mytool --version"
      judge:
        type: regex
        expr: "v\\d+\\.\\d+"

step: command（必填）+ judge（可选，省略则按 exit code 判断）
judge: regex(expr) | llm(prompt) | jsonata(expr)

Commands:
  atest run <spec.yaml>        Run tests, output JSONL trace
  atest show <trace.jsonl>     Replay trace as readable output
  atest config                 Show or set LLM configuration
  atest -V, --version          Print version
  atest -h, --help             Show this help

Output: JSONL trace (one JSON per line)
  Line types: meta | setup | step | teardown | summary
  step: {index, command, exit_code, judge_verdict, judge_reason, ...}
  judge_verdict: PASS | FAIL | RETRY
  summary: {passed, failed, retried, result: PASS|FAIL}

For details:
  atest run --help    — spec format, judge types, retry, examples, pitfalls
  atest show --help   — trace format, field reference, jq queries
  atest config --help — config file, keys, priority, examples
