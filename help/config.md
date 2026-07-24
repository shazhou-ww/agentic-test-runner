atest config — manage LLM configuration

Usage:
  atest config                  Show effective config (values + sources)
  atest config set <key> <val>   Set a config value in the file
  atest config path              Print config file path
  atest config init              Create config file with template
  atest config -h, --help        Show this help

Config file: ~/.config/atest/config.yaml
  (override path with ATEST_CONFIG env var)

Keys:
  api_key    LLM API key (masked in display)
  base_url   LLM API endpoint
  model      LLM model name

Priority: CLI flags > env vars > config file > defaults

Environment variables (override config file):
  ATEST_API_KEY    → api_key
  ATEST_BASE_URL   → base_url
  ATEST_MODEL      → model
  ATEST_CONFIG     → config file path

Examples:
  # First-time setup
  atest config init
  atest config set api_key sk-xxx
  atest config set base_url https://dashscope.aliyuncs.com/compatible-mode/v1
  atest config set model glm-5.2

  # Check what's effective (shows source for each value)
  atest config

  # Find where the config file lives
  atest config path
