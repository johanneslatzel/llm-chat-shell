import { ToolPackage } from '@johannes.latzel/llm-chat';
import {
    Workspace,
    SwitchWorkspaceTool,
    DirectoryConfiguration
} from '@johannes.latzel/llm-chat-workspace';
import { ShellConfiguration } from '../lib/config.js';
import { BashShellExecutorFactory } from '../lib/bash-executor.js';
import { ShellSessionManager } from '../lib/session-manager.js';
import { PermissionSystem } from '../lib/permission.js';
import { ShellCreateTool } from './shell-create-tool.js';
import { ShellCommandTool } from './shell-command-tool.js';
import { ShellPermissionsTool } from './shell-permissions-tool.js';
import { ShellJobStatusTool } from './shell-job-status-tool.js';
import { ShellJobsTool } from './shell-jobs-tool.js';

/**
 * A package of shell tools for LLM chat.
 * Provides `shell_create`, `shell_command`, `shell_permissions`, `shell_job_status`,
 * `shell_jobs`, and `switch_workspace` tools with a per-workspace permission system.
 * Background jobs (`shell_command` with `background=true`) run one at a time per
 * session in FIFO order; poll `shell_job_status` / `shell_jobs` for their progress.
 *
 * @example
 * ```typescript
 * // Default config (reads from env vars)
 * const pkg = new ShellPackage();
 * service.tools().add(pkg);
 *
 * // With config overrides
 * const config = new ShellConfiguration();
 * config.ctrlCTimeout = 10000;
 * config.sigtermTimeout = 3000;
 * config.permissionRules = [
 *     { pattern: 'git *', action: PermissionAction.Allow },
 *     { pattern: 'rm *', action: PermissionAction.Deny },
 * ];
 * const pkg = new ShellPackage(config);
 * service.tools().add(pkg);
 *
 * // With your own session manager and workspace (for lifecycle control)
 * const factory: ShellExecutorFactory = { create: async () => new MyExecutor() };
 * const workspace = new Workspace(new DirectoryConfiguration());
 * const manager = new ShellSessionManager(factory, config, workspace);
 * const pkg = new ShellPackage(config, manager, workspace);
 * service.tools().add(pkg);
 * // ... later:
 * await manager.close();
 * ```
 */
export class ShellPackage extends ToolPackage {
    private readonly sessionManager: ShellSessionManager;

    /**
     * @param config - Shell configuration. Defaults to a new {@link ShellConfiguration} (reads from env vars).
     * @param sessionManager - Optional pre-configured session manager. When provided, its own workspace is
     *                         used by the tools, so it must be constructed with the desired workspace.
     * @param workspace - Optional shared workspace. Only used when no session manager is provided; the
     *                    internally-built manager then shares this workspace instance.
     */
    constructor(
        config?: ShellConfiguration,
        sessionManager?: ShellSessionManager,
        workspace?: Workspace
    ) {
        const cfg = config ?? new ShellConfiguration();

        const manager =
            sessionManager ??
            new ShellSessionManager(
                new BashShellExecutorFactory(cfg),
                cfg,
                workspace ?? new Workspace(new DirectoryConfiguration())
            );

        const permissionSystem = new PermissionSystem(cfg, (root) =>
            manager.workspace.canWrite(root)
        );

        super([
            new ShellCreateTool(manager),
            new ShellCommandTool(manager, permissionSystem, manager.workspace),
            new ShellPermissionsTool(cfg, manager.workspace),
            new ShellJobStatusTool(manager),
            new ShellJobsTool(manager),
            new SwitchWorkspaceTool(manager.workspace)
        ]);

        this.sessionManager = manager;
    }

    /**
     * Close all sessions and stop background timers (idle-expiry sweeper).
     */
    async dispose(): Promise<void> {
        await this.sessionManager.dispose();
    }
}
