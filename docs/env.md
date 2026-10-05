# Environment Variables

Set these via shell, `.env`, or similar. A `.env.example` is included.

## Timeout

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_CHAT_SHELL_CTRL_C_TIMEOUT` | `30000` | Max idle time (ms) before a command is timed out; resets whenever the command produces output |
| `LLM_CHAT_SHELL_SIGTERM_TIMEOUT` | `5000` | Ms to wait after SIGTERM before escalating to SIGKILL |
| `LLM_CHAT_SHELL_KILL_TIMEOUT` | `5000` | Ms to wait after SIGKILL before giving up |
| `LLM_CHAT_SHELL_BACKGROUND_TIMEOUT` | `3600000` | Idle timeout (ms) for background jobs that do not specify a `timeout`; long silent background jobs are not killed by the short foreground timeout |
| `LLM_CHAT_SHELL_MAX_TIMEOUT` | `3600000` | Upper bound (ms) for LLM-supplied `timeout` values; larger requests are capped to this value. `0` disables the cap |

## Sessions

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_CHAT_SHELL_MAX_SESSIONS` | `10` | Max concurrent sessions |
| `LLM_CHAT_SHELL_SESSION_TIMEOUT` | `3600000` | Idle session expiry (ms, 1 hour); sessions idle this long are closed by a background sweeper |

## Permissions

Permission settings load from a config file. The environment only configures its path.

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_CHAT_SHELL_CONFIG` | unset | Path to a strict-JSON permission config file. When unset, defaults apply (deny, no rules, no per-workspace overrides). |

See [Configuration](configuration.md) for the config file schema.

The workspace package's own variables (`LLM_CHAT_WORKSPACE_*`) are documented in the [`@johannes.latzel/llm-chat-workspace`](https://johanneslatzel.github.io/llm-chat-workspace/) docs.