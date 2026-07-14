# LLM Chat Shell

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![NPM](https://nodei.co/npm/@johannes.latzel/llm-chat-shell.svg?style=shields&data=n,v,u,d,s)](https://www.npmjs.com/package/@johannes.latzel/llm-chat-shell)
[![version](https://img.shields.io/github/package-json/v/johanneslatzel/llm-chat-shell)](https://github.com/johanneslatzel/llm-chat-shell/releases)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](https://github.com/johanneslatzel/llm-chat-shell/pulls)
[![Feedback Welcome](https://img.shields.io/badge/feedback-welcome-brightgreen)](https://github.com/johanneslatzel/llm-chat-shell/discussions)
[![codecov](https://codecov.io/gh/johanneslatzel/llm-chat-shell/graph/badge.svg)](https://codecov.io/gh/johanneslatzel/llm-chat-shell)
[![CI](https://github.com/johanneslatzel/llm-chat-shell/actions/workflows/ci.yml/badge.svg)](https://github.com/johanneslatzel/llm-chat-shell/actions/workflows/ci.yml)
[![Socket Badge](https://badge.socket.dev/npm/package/@johannes.latzel/llm-chat-shell/latest)](https://badge.socket.dev/npm/package/@johannes.latzel/llm-chat-shell/latest)
[![AI Assisted Yes](https://img.shields.io/badge/AI%20Assisted-Yes-green)](https://github.com/mefengl/made-by-ai)

A tightly controlled shell tool for LLM chat, with a per-workspace permission system similar to opencode's bash tool permissions. Supports shell compositions including pipes (`|`), logical operators (`||`, `&&`), stream redirects, and more. Built on the shared [`@johannes.latzel/llm-chat-workspace`](https://johanneslatzel.github.io/llm-chat-workspace/) package for workspace access and switching.

## Features

- `shell_create`, `shell_command`, `shell_permissions`, `shell_job_status`, `shell_jobs`, and `switch_workspace` tools for persistent shell sessions
- Workspace switching decoupled from shell sessions — `switch_workspace` changes the current workspace only
- Per-workspace permission rules with global fallback
- `useCurrentWorkspace` on `shell_command` to `cd` into the current workspace and permanently rebind a session to it
- Permission system with allow/ask/deny per-command patterns
- Support for shell compositions: pipes, redirects, logical operators
- Three-phase command timeout escalation: Ctrl+C → SIGTERM → SIGKILL

## Prerequisites

- Node.js >= 18

## Installation

```bash
npm install @johannes.latzel/llm-chat-shell
```

## Documentation

Full documentation at **[johanneslatzel.github.io/llm-chat-shell/](https://johanneslatzel.github.io/llm-chat-shell/)**

The workspace package has its own documentation at **[johanneslatzel.github.io/llm-chat-workspace/](https://johanneslatzel.github.io/llm-chat-workspace/)**

## License

MIT — see [`LICENSE`](LICENSE).

## Contributing

Issues and PRs welcome at [github.com/johanneslatzel/llm-chat-shell](https://github.com/johanneslatzel/llm-chat-shell).
