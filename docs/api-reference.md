# API Reference

## Common patterns

All tools return a `PartialToolResult` with shape:

```typescript
{
    status: ResultStatus.Success | ResultStatus.Error;
    result: string; // result on success, error message on failure
    tool: string; // tool name, e.g. "shell_command"
}
```

## ShellCreateTool (tool name: `shell_create`)

Creates a new persistent shell session. Returns a session ID for use with `shell_command`.

**Parameters:**

| Parameter | Type   | Required | Description                   |
| --------- | ------ | -------- | ----------------------------- |
| `cwd` | string | no      | Working directory for this session. Must be within the workspace's accessible directories. Relative paths are resolved against the workspace. Defaults to the workspace's current path. The session is bound to the containing workspace root; permission checks for this session use that root. |

**Returns:** A session ID string.

---

## ShellCommandTool (tool name: `shell_command`)

Executes a shell command in a persistent session. Supports shell compositions including pipes (`|`), logical operators (`||`, `&&`), and stream redirects. Requires a session ID from `shell_create`.

**Parameters:**

| Parameter | Type   | Required | Description                   |
| --------- | ------ | -------- | ----------------------------- |
| `command` | string | yes      | The shell command to execute. |
| `sessionId` | string | yes      | The session ID from `shell_create`. |
| `useCurrentWorkspace` | boolean | no      | When `true`, the command is prefixed with `cd '<current workspace>' &&` and permissions are checked against the current workspace. If allowed, the session is **permanently rebound** to that workspace for all future permission checks. Defaults to `false` (uses the session's bound workspace root). |

**Returns:** Output of the command, or error message if denied/failed.

> **Note:** `cd` inside a session is unrestricted real-shell behavior and never changes the session's bound workspace root. Use `useCurrentWorkspace: true` to explicitly re-anchor a session to the current workspace.

---

## ShellPermissionsTool (tool name: `shell_permissions`)

Returns the current workspace path and the effective permission rules / default action for the current workspace.

**Parameters:** none

**Returns:** A human-readable summary, e.g.:

```
Workspace: /path/to/ws-a
Workspace root: /path/to
Default: deny
Rules:
1. git * → allow
2. rm * → deny
```

---

## SwitchWorkspaceTool (tool name: `switch_workspace`)

Changes the current workspace path to a new directory within the configured accessible directories (provided by the shared [`@johannes.latzel/llm-chat-workspace`](https://johanneslatzel.github.io/llm-chat-workspace/) package). It only changes `Workspace.currentPath`; it does **not** touch any shell session or its working directory.

**Parameters:**

| Parameter | Type   | Required | Description                   |
| --------- | ------ | -------- | ----------------------------- |
| `path` | string | yes      | Target directory path within the configured accessible directories. |

**Returns:** `Switched workspace to: <path>`, or an error if the target is outside the accessible directories.

> **Note:** Sessions are decoupled from workspace switches. Existing sessions keep their original bound workspace root (and cwd); use `useCurrentWorkspace` on `shell_command` to re-anchor them.

---

## ShellCommandResult

Returned by `BashShellExecutor.execute()`. Tool results wrap the raw text in the common
`PartialToolResult` shape; the fields below describe the underlying command outcome.

| Field | Type | Description |
|-------|------|-------------|
| `stdout` | string | Standard output of the command |
| `stderr` | string | Standard error of the command |
| `exitCode` | number | Exit code of the command (0 = success) |
| `timedOut` | boolean | True if the command was killed due to timeout |
| `sessionAlive` | boolean | False if the bash process was killed (session is dead) |
| `idleTimeoutMs` | number | Ms of inactivity (`ctrlCTimeout`) after which the command was timed out; present when `timedOut` is true |

### Session death

Sessions do not survive death. When a session is timed out, idle-expired, exits, or is
closed it is removed from the registry and recorded as a tombstone, so a stale session ID
keeps returning a descriptive error instead of a bare "not found", for example:

```
Session <id> was killed because a command produced no output for too long (idle limit: 30000ms). Create a new session to continue.
```

Reasons: `timeout` (command produced no output for too long), `expired` (session idle
longer than `sessionTimeout`), `process-exited`, `closed`.

---

## Permission System

Commands are evaluated against configured permission rules. Rules can be configured **globally** and **per workspace**.

```typescript
{
    "shell": {
        "git *": "allow",
        "rm *": "deny",
        "*": "ask"
    }
}
```

Per-workspace settings keyed by resolved workspace root (from the config file's `workspacePermissions` or `config.workspacePermissions`):

```typescript
{
    "/path/to/ws-a": {
        "defaultPermission": "allow",
        "permissionRules": [
            { "pattern": "rm *", "action": "deny" }
        ]
    }
}
```

A workspace root with no per-workspace entry falls back to the global `defaultPermission` / `permissionRules`.

### Effective workspace root for a session

- At `shell_create`, the session is bound to the deepest workspace root containing the requested `cwd` (or `Workspace.currentPath`).
- All permission checks for that session use its bound root.
- `switch_workspace` never changes a session's bound root.
- `useCurrentWorkspace: true` on `shell_command` checks against the current workspace and permanently rebinds the session on allow.
- `cd` inside a session never affects permission checks.

### Supported patterns

- `git *` — matches any git command
- `ls` — exact match
- `*` — catch-all

### Shell compositions

The permission system evaluates the full composed command, supporting:

- Pipes: `cmd1 | cmd2`
- Logical AND: `cmd1 && cmd2`
- Logical OR: `cmd1 || cmd2`
- Stream redirects: `cmd > file`, `cmd >> file`, `cmd < file`

---

## ShellConfiguration

Configuration class for the shell executor. Timeouts and session limits read from environment variables; permission settings load from a config file pointed to by `LLM_CHAT_SHELL_CONFIG`.

```typescript
import { ShellConfiguration } from 'llm-chat-shell';

const config = new ShellConfiguration();
```

### Timeout properties

| Property | Env Var | Default | Description |
|----------|---------|---------|-------------|
| `ctrlCTimeout` | `LLM_CHAT_SHELL_CTRL_C_TIMEOUT` | `30000` | Max idle time (ms) before a command is timed out; the timer resets whenever the command produces output |
| `sigtermTimeout` | `LLM_CHAT_SHELL_SIGTERM_TIMEOUT` | `5000` | Ms to wait after SIGTERM before escalating to SIGKILL |
| `killTimeout` | `LLM_CHAT_SHELL_KILL_TIMEOUT` | `5000` | Ms to wait after SIGKILL before giving up |

### Session properties

| Property | Env Var | Default | Description |
|----------|---------|---------|-------------|
| `maxSessions` | `LLM_CHAT_SHELL_MAX_SESSIONS` | `10` | Max concurrent sessions |
| `sessionTimeout` | `LLM_CHAT_SHELL_SESSION_TIMEOUT` | `3600000` | Idle session expiry (ms, 1 hour): sessions idle this long are closed by a background sweeper |

### Permission properties

| Property | Env Var | Default | Description |
|----------|---------|---------|-------------|
| `configFilePath` | `LLM_CHAT_SHELL_CONFIG` | — | Path to the strict-JSON permission config file. When set, `defaultPermission`, `permissionRules`, and `workspacePermissions` load from it. |
| `defaultPermission` | config file `globalPermissions.defaultPermission` | `PermissionAction.Deny` | Global default permission for unmatched commands |
| `permissionRules` | config file `globalPermissions.permissionRules` | `[]` | Global permission rules |
| `workspacePermissions` | config file `workspacePermissions` | `new Map()` | Per-workspace overrides as `Map<resolvedRoot, WorkspacePermissions>`. Programmatic assignments take precedence over the config file. |

The config file is strict JSON (no comments) — see [`docs/env.md`](env.md) for the full format. Loading it via `loadShellConfigFile(path)` throws on an unreadable file, invalid JSON, or an invalid shape.

### Methods

| Method | Description |
|--------|-------------|
| `resolvePermissions(workspaceRoot: string)` | Returns the `WorkspacePermissions` for a root, falling back to the global `defaultPermission` / `permissionRules` when the root has no entry (or is `''`). |

---

## WorkspacePermissions

```typescript
interface WorkspacePermissions {
    defaultPermission: PermissionAction;
    permissionRules: PermissionRule[];
}
```

---

## Package classes

### ShellPackage

Groups the `shell_create`, `shell_command`, `shell_permissions`, and `switch_workspace` tools with a per-workspace permission system.

```typescript
import { ShellPackage } from 'llm-chat-shell';
const pkg = new ShellPackage();
service.tools().add(pkg);
```

- **Tools:** shell_create, shell_command, shell_permissions, switch_workspace (4 tools)
- **Constructor:** `(config?, sessionManager?, workspace?)` — when a `sessionManager` is provided its own workspace is used; otherwise `workspace` (or an internally built `Workspace(new DirectoryConfiguration())`) is shared by the tools.
- **`dispose()`:** closes all sessions and stops the idle-expiry sweeper (delegates to the session manager)
