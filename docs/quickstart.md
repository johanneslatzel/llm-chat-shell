# Quick Start

## Installation

```bash
npm install @johannes.latzel/llm-chat-shell
```

## Quick setup

```typescript
import { ShellPackage } from 'llm-chat-shell';

const pkg = new ShellPackage();
service.tools().add(pkg);
```

## Permission configuration

Allow git commands, deny destructive operations, and prompt for everything else:

```typescript
import { ShellPackage, ShellConfiguration, PermissionAction } from 'llm-chat-shell';

const config = new ShellConfiguration();
config.defaultPermission = PermissionAction.Deny;
config.permissionRules = [
    { pattern: 'git *', action: PermissionAction.Allow },
    { pattern: 'ls *', action: PermissionAction.Allow },
    { pattern: 'rm *', action: PermissionAction.Deny },
];

const pkg = new ShellPackage(config);
service.tools().add(pkg);
```

## Session management

The package manages sessions automatically. For explicit lifecycle control:

The workspace is provided by the [`@johannes.latzel/llm-chat-workspace`](https://johanneslatzel.github.io/llm-chat-workspace/) package:

```typescript
import { ShellPackage, ShellConfiguration, ShellSessionManager, BashShellExecutor } from 'llm-chat-shell';
import { Workspace, DirectoryConfiguration } from '@johannes.latzel/llm-chat-workspace';

const config = new ShellConfiguration();
config.maxSessions = 5;
config.sessionTimeout = 1800000; // 30 minutes

const workspace = new Workspace(new DirectoryConfiguration());
const manager = new ShellSessionManager(
    { create: (cwd?) => Promise.resolve(new BashShellExecutor(cwd ? { ...config, cwd } : config)) },
    config,
    workspace
);
const pkg = new ShellPackage(config, manager);
service.tools().add(pkg);

// ... later:
await manager.close();
```

## MCP server usage

When using with an MCP server, the client can pass a `cwd` to `shell_create` to run commands in a specific directory:

```typescript
import { ShellPackage, ShellConfiguration } from 'llm-chat-shell';

const config = new ShellConfiguration();

const pkg = new ShellPackage(config);
mcpServer.register(pkg);

// MCP client calls: shell_create({ cwd: "/path/to/project" })
// Sessions are scoped to that directory
```

The `cwd` parameter is validated to ensure it resolves within the workspace's accessible directories. Relative paths are resolved against the current workspace.

## Next steps

See the [API Reference](api-reference.md) for full tool documentation and [Architecture](architecture.md) for design details.
