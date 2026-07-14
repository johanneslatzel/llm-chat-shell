import {
    Tool,
    ToolParameters,
    ToolParameterProperty,
    ResultStatus,
    type PartialToolResult
} from '@johannes.latzel/llm-chat';
import type { Workspace } from '@johannes.latzel/llm-chat-workspace';
import type { ShellSessionManager } from './session-manager.js';
import { PermissionSystem, type PermissionCheckResult, workspaceForPath } from './permission.js';
import { PermissionAction } from './types.js';
import type { ShellJob } from './types.js';

/** Single-quote a shell path so it can be safely embedded in a command. */
function shellQuoteSingle(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A command prepared for execution and the workspace root its permissions are checked against. */
interface EffectiveCommand {
    /** The command string that is actually executed (may include a `cd` prefix). */
    command: string;
    /** The command string the permission check runs against (without the `cd` prefix). */
    commandToCheck: string;
    /** Resolved workspace root used for permission resolution. */
    workspaceRoot: string;
}

/**
 * Tool that executes a shell command in a persistent session.
 * Checks command permissions before execution. With `background=true` the
 * command is submitted as a queued job and the tool returns a job ID
 * immediately; poll `shell_job_status` for its progress and results.
 */
export class ShellCommandTool extends Tool {
    constructor(
        private sessionManager: ShellSessionManager,
        private permissionSystem: PermissionSystem,
        private workspace: Workspace
    ) {
        super(
            'shell_command',
            'Executes a shell command in a persistent session. Supports pipes (|), logical operators (&&, ||), and redirects. Requires a session ID from shell_create. ' +
                'Set background=true to submit the command as a queued job and return immediately with a job ID; poll shell_job_status / shell_jobs for results. ' +
                'Set timeout to override the max idle time (no output) in ms; larger values are capped by the server config. ' +
                'Set useCurrentWorkspace=true to cd into the current workspace before running the command and permanently rebind the session to it.',
            new ToolParameters(
                {
                    command: ToolParameterProperty.string('The shell command to execute.'),
                    sessionId: ToolParameterProperty.string('The session ID from shell_create.'),
                    useCurrentWorkspace: ToolParameterProperty.boolean(
                        'When true, cd into the current workspace before executing and permanently bind this session to that workspace.'
                    ),
                    background: ToolParameterProperty.boolean(
                        'When true, submit the command as a background job, return immediately with a jobId, and continue with other work. Poll shell_job_status for the result.'
                    ),
                    timeout: ToolParameterProperty.integer(
                        'Max idle time in ms (no stdout/stderr output) before the command is killed. Defaults to the configured foreground or background timeout; larger values are capped by the server config.'
                    )
                },
                ['command', 'sessionId']
            )
        );
    }

    protected async onExecute(args: Record<string, unknown>): Promise<PartialToolResult> {
        this.validateRequiredParams(args, ['command', 'sessionId']);

        const command = args['command'] as string;
        const sessionId = args['sessionId'] as string;
        const useCurrentWorkspace = args['useCurrentWorkspace'] === true;
        const background = args['background'] === true;
        const timeout = this.parseTimeout(args['timeout']);

        const effective = await this.buildEffectiveCommand(sessionId, command, useCurrentWorkspace);

        // Check permissions against the effective workspace root
        const permission = this.permissionSystem.check(
            effective.commandToCheck,
            effective.workspaceRoot
        );
        if (permission.action === PermissionAction.Deny) {
            const deniedSubs = this.getDeniedSubcommands(permission, effective.workspaceRoot);
            const message =
                deniedSubs.length > 0
                    ? `Permission denied for: ${deniedSubs.join(', ')}`
                    : 'Permission denied';
            return { result: message, status: ResultStatus.Error };
        }

        // Permanently rebind the session once the command is allowed
        if (useCurrentWorkspace) {
            await this.sessionManager.rebindSession(sessionId, effective.workspaceRoot);
        }

        if (background) {
            const job = await this.sessionManager.submitCommand(
                sessionId,
                effective.command,
                timeout !== undefined ? { timeout } : undefined
            );
            return { result: this.formatJobSubmitted(job), status: ResultStatus.Success };
        }

        // Execute command (blocks until the shell gets to it, running queued jobs first)
        const result = await this.sessionManager.executeCommand(
            sessionId,
            effective.command,
            timeout !== undefined ? { timeout } : undefined
        );

        // Format output
        const output = this.formatOutput(result);
        const status = result.exitCode === 0 ? ResultStatus.Success : ResultStatus.Error;

        return { result: output, status };
    }

    /** Only finite, positive numbers are honored; anything else falls back to the default. */
    private parseTimeout(value: unknown): number | undefined {
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
            return undefined;
        }
        return value;
    }

    /**
     * Build the command to execute and the workspace root its permissions are
     * checked against. When `useCurrentWorkspace` is true, the command is
     * prefixed with a `cd` into the current workspace and the workspace root is
     * derived from that path; otherwise the session's bound root is used.
     */
    private async buildEffectiveCommand(
        sessionId: string,
        command: string,
        useCurrentWorkspace: boolean
    ): Promise<EffectiveCommand> {
        if (!useCurrentWorkspace) {
            return {
                command,
                commandToCheck: command,
                workspaceRoot: await this.sessionManager.getSessionWorkspaceRoot(sessionId)
            };
        }
        const roots = this.workspace.getAccesses().map((a) => a.path);
        const workspaceRoot = workspaceForPath(this.workspace.currentPath, roots);
        return {
            command: `cd ${shellQuoteSingle(this.workspace.currentPath)} && ${command}`,
            commandToCheck: command,
            workspaceRoot
        };
    }

    private getDeniedSubcommands(
        permission: PermissionCheckResult,
        workspaceRoot: string
    ): string[] {
        // Re-check each subcommand to find which ones are denied
        const denied: string[] = [];
        for (const sub of permission.subcommands) {
            const check = this.permissionSystem.check(sub, workspaceRoot);
            if (check.action === PermissionAction.Deny) {
                denied.push(sub);
            }
        }
        return denied;
    }

    private formatJobSubmitted(job: ShellJob): string {
        return `Background job ${job.id} submitted (status: ${job.status}, queue position ${job.position}). Poll shell_job_status with this jobId for results.`;
    }

    private formatOutput(result: {
        stdout: string;
        stderr: string;
        exitCode: number;
        timedOut: boolean;
        sessionAlive: boolean;
        idleTimeoutMs?: number;
    }): string {
        const parts: string[] = [];

        // Add timeout/session death messages first
        const idleLimit =
            result.idleTimeoutMs !== undefined ? ` (idle limit: ${result.idleTimeoutMs}ms)` : '';
        if (result.timedOut && !result.sessionAlive) {
            parts.push(`Command timed out and session was killed${idleLimit}.`);
        } else if (result.timedOut) {
            parts.push(`Command timed out${idleLimit}.`);
        }

        if (!result.sessionAlive) {
            parts.push('Session is no longer alive. Create a new session to continue.');
        }

        if (result.stdout.length > 0) {
            parts.push(result.stdout);
        }
        if (result.stderr.length > 0) {
            parts.push(`[stderr] ${result.stderr}`);
        }
        if (result.exitCode !== 0) {
            parts.push(`[exit code: ${result.exitCode}]`);
        }

        return parts.length > 0 ? parts.join('\n') : '(no output)';
    }
}
