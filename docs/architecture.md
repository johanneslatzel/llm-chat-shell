# Architecture

## Overview

`@johannes.latzel/llm-chat-shell` provides a tightly controlled shell tool for LLM chat applications. It implements a permission system similar to opencode's bash tool permissions, allowing shell compositions including pipes (`|`), logical operators (`||`, `&&`), and stream redirects.

## Design

### Tool classes

Each tool extends `Tool` from `llm-chat`:

1. Constructor calls `super(name, description, params)` with a `ToolParameters` instance
2. `onExecute()` validates parameters, performs the operation, and returns `PartialToolResult`
3. All errors are caught and returned as plain-string messages; tools never throw

### Permission System

Commands are evaluated against a permission system with two levels:

- `allow`: execute without prompting
- `deny`: block execution

Permissions support pattern matching on command strings, with support for shell compositions.

### Package classes

The `ToolPackage` abstract class (from `@johannes.latzel/llm-chat`) groups related tools for registration:

```typescript
abstract class ToolPackage {
    tools(): Tool[];
}
```

`ShellPackage` extends `ToolPackage` and adds a `dispose()` method that closes all sessions and stops the idle sweeper.

| Class          | Tools     | Constructor | `dispose()`     |
| -------------- | --------- | ----------- | --------------- |
| `ShellPackage` | shell_create, shell_command, shell_permissions, shell_job_status, shell_jobs, switch_workspace | optional `config`, `sessionManager`, `workspace` | closes sessions, stops idle sweeper |

## Dependencies

- `llm-chat`: framework providing `Tool`, `ToolParameters`, etc.

## Sentinel Protocol

The `BashShellExecutor` communicates with a persistent bash process via stdin/stdout. Bash stdout is a raw byte stream with no "end of output" marker, and the exit code (`$?`) only exists inside bash's memory.

The `SentinelProtocol` class solves both problems:

1. Generates a unique UUID-based sentinel string
2. Sends the user command + `echo "<sentinel>"` to bash's stdin
3. Watches stdout; non-matching lines are collected as output
4. When the sentinel line appears, extracts the exit code from the expanded `$?`
5. Resolves the promise with the exit code

The UUID prevents false matches if a command outputs text resembling a sentinel.

## Idle-Based Timeout

When a command stops producing output (e.g., a hung `sleep 999`), the `TimeoutEscalation` class terminates it through a three-phase escalation. The trigger is **inactivity**, not wall-clock time: the timer is re-armed whenever the command writes to stdout or stderr, so long-running but chatty commands are never killed.

| Phase | Signal | Target | Default | Purpose |
|-------|--------|--------|---------|---------|
| 1 | Ctrl+C (`\x03`) | Foreground command (via process group) | 30s (idle limit) | Interrupt the command |
| 2 | SIGTERM | Bash process | 5s | Terminate bash gracefully |
| 3 | SIGKILL | Bash process (force) | 5s | Force kill if still alive |

While Phase 1 is still pending, any new output resets the idle timer; once the escalation commits to Phase 2 the timer is no longer resettable. If the command finishes during Phase 1, the session stays alive. Phases 2 and 3 kill the bash process.

`ShellCommandResult` describes the outcome:

- **`timedOut`**: `true` if the command was killed due to timeout
- **`idleTimeoutMs`**: the idle limit (`ctrlCTimeout`) the command exceeded; present when `timedOut` is true
- **`sessionAlive`**: `false` if the bash process was killed

## Session Manager

`ShellSessionManager` composes three lock-free modules: a `JobRegistry` (the bounded store of every submitted job, live or finished), a `SessionRegistry` (the live sessions plus the tombstones of dead ones), and a `SessionQueue` (the per-session FIFO worker loop). It owns the single mutex that serializes the operations spanning an `await`: session creation (the factory call is awaited while holding the lock, so concurrent creates cannot both pass the `maxSessions` check), teardown, and expiry.

The components themselves hold no lock. Their operations are synchronous and therefore atomic under the single-threaded event loop, so they interleave safely with the manager's mutex-protected blocks.

The worker loop runs outside the mutex by design. Its per-job bookkeeping is a single synchronous block (it must never gain an `await` in the middle), and each session's `processing` flag guarantees at most one worker.

Executor close is single-owner: whoever removes a session from the registry closes its executor, either a teardown caller (`close`, `closeSession`, idle expiry) or the worker on a session that died naturally.

The worker drains each session's queue one job at a time (a shell executes a single command at a time), and background submissions return immediately with a job to poll. Completed and failed jobs stay queryable by ID until the oldest are evicted FIFO beyond the job cap; queued and running jobs are never evicted.

Every job carries its own working directory (the session's cwd, or the current workspace with `useCurrentWorkspace`). Before running a job, the executor re-anchors the persistent shell into the job's directory via a `cd` prefix, so a queued command always runs in the directory it was submitted for, regardless of where earlier jobs left the shell. A `cd` inside a command only affects that command; it never changes the session's tracked cwd.

Beyond enforcing `maxSessions`, the registry keeps itself clean so session slots are never permanently lost:

- **Pruning:** before creating a session, sessions whose underlying process has exited are removed and tombstoned.
- **Post-command cleanup:** after a command that timed out or killed the shell, the session is removed and tombstoned; close failures are swallowed.
- **Idle expiry:** a background sweeper ticks every `sessionTimeout / 2` (min 1s, `.unref()`ed) and closes sessions idle for at least `sessionTimeout`. In-flight sessions are never expired. The sweeper is skipped when `sessionTimeout` is `<= 0` or non-finite.

Dead sessions are recorded as **tombstones** (bounded, FIFO, cap 100) so stale session IDs keep producing a descriptive error instead of a bare "not found", e.g.:

```
Session <id> was killed because a command produced no output for too long (idle limit: 30000ms). Create a new session to continue.
```

Death reasons: `timeout` (idle limit exceeded), `expired` (idle session expiry), `process-exited`, and `closed`. `dispose()` closes all sessions and stops the sweeper.
