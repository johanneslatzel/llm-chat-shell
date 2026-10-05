# API Reference

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
| `useCurrentWorkspace` | boolean | no      | When `true`, the command runs in the current workspace and permissions are checked against it. If allowed, the session is **permanently rebound** to that workspace for all future permission checks and command cwds. Defaults to `false` (uses the session's bound workspace root and cwd). |
| `background` | boolean | no      | When `true`, submit the command as a queued background job and return immediately with a job ID. Poll `shell_job_status` / `shell_jobs` for results. Defaults to `false`. |
| `timeout` | integer | no      | Max idle time in ms (no stdout/stderr output) before the command is killed. Defaults to the configured foreground or background timeout; larger values are capped by the server config. |

**Returns:** Output of the command, or error message if denied/failed.

Each job runs in its own working directory (the session's cwd, or the current workspace with `useCurrentWorkspace: true`); the executor re-anchors there before running, and a `cd` inside a command affects only that command.

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

## ShellJobStatusTool (tool name: `shell_job_status`)

Returns the status and, once finished, the results (stdout, stderr, exit code) of a background job submitted with `shell_command` (`background=true`).

**Parameters:**

| Parameter | Type   | Required | Description                   |
| --------- | ------ | -------- | ----------------------------- |
| `jobId` | string | yes      | The job ID returned by `shell_command` when `background=true`. |

**Returns:** A human-readable job report with status, working directory, timestamps, and (once completed) output, exit code, and timeout/session-alive flags.

---

## ShellJobsTool (tool name: `shell_jobs`)

Lists the background jobs submitted to a session (queued, running, completed, failed), oldest first.

**Parameters:**

| Parameter | Type   | Required | Description                   |
| --------- | ------ | -------- | ----------------------------- |
| `sessionId` | string | yes      | The session ID from `shell_create`. |

**Returns:** One line per job in `<status>\t<id>\t<cwd>\t<command>` form, or `No jobs for session <sessionId>.`

---

## SwitchWorkspaceTool (tool name: `switch_workspace`)

Changes the current workspace path to a new directory within the configured accessible directories (provided by the shared [`@johannes.latzel/llm-chat-workspace`](https://johanneslatzel.github.io/llm-chat-workspace/) package). It only changes `Workspace.currentPath`; it does **not** touch any shell session or its working directory.

**Parameters:**

| Parameter | Type   | Required | Description                   |
| --------- | ------ | -------- | ----------------------------- |
| `path` | string | yes      | Target directory path within the configured accessible directories. |

**Returns:** `Switched workspace to: <path>`, or an error if the target is outside the accessible directories.

Sessions are decoupled from workspace switches. Existing sessions keep their original bound workspace root and cwd; use `useCurrentWorkspace` on `shell_command` to re-anchor them.

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

Commands are evaluated against configured permission rules, configured **globally** and **per workspace** from a strict-JSON config file (see [Configuration](configuration.md) for the full schema). Each rule is `{ pattern, action, access?, type? }`. The effective `access` (default `read`) and effective `type` (default `command`) come from the rule's own fields or the section's `defaultAccess` / `defaultType`. A `write` rule only applies in a workspace whose root grants write access.

### Rule families

A single `permissionRules` list holds both families. A rule's effective type (`type` or `defaultType`) selects what it authorizes:

- `command` rules match **command cores only** (the command name and arguments, redirects stripped).
- `redirect` rules match **redirect targets only** (the literal path after a redirect operator).

A redirect target can never be authorized by a command rule and vice versa.

### Redirect evaluation

Redirects default to **deny**: a target with no matching `redirect` rule is denied even when the core is allowed. `output` redirects (`>`, `>>`, `>|`, `&>`, `&>>`, `<>`) need a write-class allow redirect rule (gated by workspace write access); `input` redirects (`<`) need a read-class one. Targets match literally - no `~`, env, or path resolution - and `/dev/null` needs an explicit rule. fd-dups and heredocs access no file and need none.

### Effective workspace root and cwd for a session

- `shell_create` binds the session to the deepest workspace root containing the requested `cwd`; all permission checks use that root.
- `useCurrentWorkspace: true` checks against the current workspace and, on allow, permanently rebinds the session.
- `switch_workspace` never changes a session's bound root or cwd; a `cd` inside a command affects only that command.

### Shell compositions

The permission system evaluates the full composed command: pipes (`cmd1 | cmd2`), `&&`, `||`, and stream redirects (`cmd > file`).

---

## ShellConfiguration

Configuration class for the shell executor. Timeouts and session limits read from environment variables; permission settings load from a config file pointed to by `LLM_CHAT_SHELL_CONFIG`.

```typescript
import { ShellConfiguration } from '@johannes.latzel/llm-chat-shell';

const config = new ShellConfiguration();
```

### Timeout properties

Env vars and their defaults are documented in [Environment Variables](env.md).

| Property | Description |
|----------|-------------|
| `ctrlCTimeout` | Foreground command idle timeout; the timer resets on each output |
| `sigtermTimeout` | SIGTERM-to-SIGKILL escalation grace period |
| `killTimeout` | Grace period after SIGKILL before giving up |
| `backgroundTimeout` | Fallback idle timeout for background jobs without an explicit `timeout` |
| `maxTimeout` | Cap applied to an LLM-supplied `timeout`; `0` disables the cap |

### Session properties

| Property | Description |
|----------|-------------|
| `maxSessions` | Concurrent session limit |
| `sessionTimeout` | Idle expiry for a session; sessions idle this long are closed by the background sweeper |

### Permission properties

| Property | Description |
|----------|-------------|
| `configFilePath` | Path to the strict-JSON permission config file; when set, `defaultPermission`, `defaultType`, `defaultAccess`, `permissionRules`, and `workspacePermissions` load from it |
| `defaultPermission` | Global default action for unmatched commands |
| `defaultType` | Global default rule type for rules without an explicit `type`; `PermissionType.Command` or `PermissionType.Redirect` |
| `defaultAccess` | Global default access for rules without an explicit `access`; `PermissionAccess.Read` or `PermissionAccess.Write` |
| `permissionRules` | Global rules for command cores and redirect targets; each is `{ pattern, action, access?, type? }` |
| `workspacePermissions` | Per-workspace overrides as `Map<resolvedRoot, WorkspacePermissions>`; programmatic assignment takes precedence over the config file |

The config file schema and loading semantics are documented in [Configuration](configuration.md); `loadShellConfigFile(path)` throws on an unreadable file, invalid JSON, or an invalid shape.

### Methods

| Method | Description |
|--------|-------------|
| `resolvePermissions(workspaceRoot: string)` | Returns the `WorkspacePermissions` for a root, falling back to the global `defaultPermission` / `defaultType` / `defaultAccess` / `permissionRules` when the root has no entry (or is `''`). |
| `resolveIdleTimeout(background: boolean, requested?: number)` | Returns the effective idle timeout: a positive `requested` value wins (capped at `maxTimeout` when enabled); otherwise `backgroundTimeout` for background jobs, `ctrlCTimeout` for foreground commands. |

---

## WorkspacePermissions

```typescript
interface WorkspacePermissions {
    defaultPermission: PermissionAction;
    defaultType: PermissionType;
    defaultAccess: PermissionAccess;
    permissionRules: PermissionRule[];
}
```

---

## PermissionType

```typescript
enum PermissionType {
    Command = 'command',
    Redirect = 'redirect'
}
```

A rule's effective type selects which surface it authorizes: `command` rules match
command cores, `redirect` rules match redirect targets. Rules without an explicit
`type` use the section's `defaultType`.

---

## Package classes

### ShellPackage

Groups the `shell_create`, `shell_command`, `shell_permissions`, `shell_job_status`, `shell_jobs`, and `switch_workspace` tools with a per-workspace permission system.

```typescript
import { ShellPackage } from '@johannes.latzel/llm-chat-shell';
const pkg = new ShellPackage();
service.tools().add(pkg);
```

- **Tools:** shell_create, shell_command, shell_permissions, shell_job_status, shell_jobs, switch_workspace (6 tools)
- **Constructor:** `(config?, sessionManager?, workspace?)`: when a `sessionManager` is provided its own workspace is used; otherwise `workspace` (or an internally built `Workspace(new DirectoryConfiguration())`) is shared by the tools.
- **`dispose()`:** closes all sessions and stops the idle-expiry sweeper (delegates to the session manager)
