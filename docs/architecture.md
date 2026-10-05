# Architecture

## Overview

`@johannes.latzel/llm-chat-shell` provides a tightly controlled shell tool for LLM chat applications, with a per-workspace permission system similar to opencode's bash tool permissions. It supports shell compositions: pipes (`|`), logical operators (`||`, `&&`), and stream redirects.

## Tools

Tools extend `Tool` from `llm-chat` and return `PartialToolResult`; all errors are caught and returned as plain-string messages — tools never throw. `ShellPackage` (constructor `(config?, sessionManager?, workspace?)`) groups the shell tools, and `dispose()` closes all sessions and stops the idle sweeper.

## Sentinel Protocol

`BashShellExecutor` talks to a persistent bash process over stdin/stdout. Bash stdout has no end-of-output marker and `$?` exists only inside bash, so `SentinelProtocol` appends `echo "<uuid-sentinel>"` to each command, collects non-matching stdout lines as output, and extracts the exit code from the sentinel line. The UUID prevents false matches when command output resembles the sentinel.

## Idle-Based Timeout

Timeout is triggered by **inactivity**, not wall-clock time: the timer re-arms on every output line, so long-running but chatty commands are never killed. `TimeoutEscalation` then runs:

| Phase | Signal | Target | Default | Purpose |
|-------|--------|--------|---------|---------|
| 1 | Ctrl+C (`\x03`) | Foreground command (via process group) | 30s (idle limit) | Interrupt the command |
| 2 | SIGTERM | Bash process | 5s | Terminate bash gracefully |
| 3 | SIGKILL | Bash process (force) | 5s | Force kill if still alive |

Output during Phase 1 resets the idle timer and lets the command finish with the session alive; Phases 2 and 3 kill the bash process.

## Session Manager

`ShellSessionManager` composes three lock-free modules — `JobRegistry` (bounded job store), `SessionRegistry` (live sessions plus tombstones), and `SessionQueue` (per-session FIFO worker) — and owns the single mutex that serializes operations spanning an `await` (session creation, teardown, expiry). The worker loop runs outside the mutex; its per-job bookkeeping is one synchronous block and a per-session `processing` flag guarantees a single worker. Executor close is single-owner: whoever removes a session from the registry closes it.

Every job runs in its own working directory: the executor re-anchors the shell with a `cd` prefix before each job, so a queued command always runs in the directory it was submitted for; a `cd` inside a command affects only that command.

The registry keeps session slots free:

- **Pruning:** before creating a session, sessions whose process has exited are removed and tombstoned.
- **Post-command cleanup:** a command that timed out or killed the shell tombstones the session.
- **Idle expiry:** a sweeper ticks every `sessionTimeout / 2` (min 1s, `.unref()`ed) and closes sessions idle at least `sessionTimeout`; in-flight sessions are never expired, and the sweeper is skipped when `sessionTimeout <= 0` or non-finite.

Dead sessions become **tombstones** (bounded FIFO, cap 100) so stale session IDs keep returning a descriptive error instead of "not found". Death reasons: `timeout`, `expired`, `process-exited`, `closed`. `dispose()` closes all sessions and stops the sweeper.

## Redirect Permission Rules

### Problem

Redirects were previously stripped before permission matching: the core was checked against the command rules but the raw command (including redirects) ran, so any allowed command could redirect output to an arbitrary file (e.g. `git diff HEAD > /etc/cron.d/foo`), bypassing the read/write workspace tiering.

### Model

The parser extracts every file-expecting redirect from each subcommand into a `(mode, target)` token. A single `permissionRules` list holds both families: a rule's effective type (`type`, or the section's `defaultType`) decides whether it is a `command` rule matching **command cores only** or a `redirect` rule matching **redirect targets only**; neither can authorize the other's value. A fragment with no matching redirect rule is denied — redirects default to deny.

### Redirect taxonomy

All forms map to one token of mode `output` or `input` (fd-numbered forms via their digit prefix); targets stay literal (`~` and `$VAR` are not resolved) and quoted targets are unquoted.

| Form | Mode | Target |
|------|------|--------|
| `>` | output | file word after the operator |
| `>|` | output | file word after the operator |
| `>>` | output | file word after the operator |
| `&>` | output | file word after the operator |
| `&>>` | output | file word after the operator |
| `<>` | output | file word after the operator (opened `O_RDWR`, may create/modify) |
| `1>`, `2>`, `n>` | output | file word after the operator |
| `<` | input | file word after the operator |
| `0<`, `n<` | input | file word after the operator |

No file access, no token:

| Form | Why |
|------|-----|
| `2>&1`, `1>&2`, `>&N`, `>&-`, `<&N`, `<&-` | file descriptor duplication/closing |
| `>& file` | stdout+stderr to `file` (output) — only when the word is not a descriptor |
| `<<EOF`, `<<<` | heredoc / here-string, input from script text |

### Tokenization order

Operators match longest-first so shorter ones cannot shadow longer: `&>>` before `&>`, `>>`/`>|`/`>&` before `>`, `<>`/`<&`/`<<<`/`<<` before `<`. fd-numbered redirects consume a digit run before the operator.

### Matching

Redirect rules reuse the command-rule specificity criteria (dominance, wildcard count, literal count, then first declared), restricted to same-family rules. A deny rule denies the token; an allow rule must satisfy the mode-to-tier binding: `output` tokens need `access: "write"` (gated by workspace writability — `write-access` in a read-only workspace), `input` tokens `access: "read"` (the effective `defaultAccess`).

### Redirect-only fragments

A fragment consisting only of a redirect (e.g. `> file`) still creates or truncates the file, so it is retained and checked via its tokens; empty input (no fragments) denies.