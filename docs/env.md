# Environment Variables

Set these however you prefer (shell, `.env`, etc.). A `.env.example` is included.

## Timeout

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_CHAT_SHELL_CTRL_C_TIMEOUT` | `30000` | Max idle time (ms) before a command is timed out; resets whenever the command produces output |
| `LLM_CHAT_SHELL_SIGTERM_TIMEOUT` | `5000` | Ms to wait after SIGTERM before escalating to SIGKILL |
| `LLM_CHAT_SHELL_KILL_TIMEOUT` | `5000` | Ms to wait after SIGKILL before giving up |

## Sessions

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_CHAT_SHELL_MAX_SESSIONS` | `10` | Max concurrent sessions |
| `LLM_CHAT_SHELL_SESSION_TIMEOUT` | `3600000` | Idle session expiry (ms, 1 hour); sessions idle this long are closed by a background sweeper |

## Permissions

Permission settings load from a config file. The environment only configures its path.

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_CHAT_SHELL_CONFIG` | — | Path to a strict-JSON permission config file. When unset, defaults apply (deny, no rules, no per-workspace overrides). |

### Config file

The config file is strict JSON (no comments) and may contain:

- `globalPermissions` — the global settings as a full `{ "defaultPermission", "permissionRules" }` set (defaults: `"deny"`, `[]`)
- `workspacePermissions` — an object keyed by resolved workspace root path, each value a full `{ "defaultPermission", "permissionRules" }` set

```json
{
    "globalPermissions": {
        "defaultPermission": "deny",
        "permissionRules": [
            { "pattern": "git *", "action": "allow" },
            { "pattern": "rm *", "action": "deny" }
        ]
    },
    "workspacePermissions": {
        "/path/to/ws-a": {
            "defaultPermission": "allow",
            "permissionRules": [{ "pattern": "rm *", "action": "deny" }]
        }
    }
}
```

A ready-to-copy example lives in [`shell-config.example.json`](../shell-config.example.json).

A workspace root with no `workspacePermissions` entry falls back to the global settings in `globalPermissions`. If the config file is unreadable, invalid JSON, or has an invalid shape, `ShellConfiguration` throws at construction — it never silently falls back to permissive defaults.

The workspace package's own variables (`LLM_CHAT_WORKSPACE_*`) are documented in the [`@johannes.latzel/llm-chat-workspace`](https://johanneslatzel.github.io/llm-chat-workspace/) docs.

