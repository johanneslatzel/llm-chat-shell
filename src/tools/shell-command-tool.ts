import {
    Tool,
    ToolParameters,
    ToolParameterProperty,
    ResultStatus,
    type PartialToolResult
} from '@johannes.latzel/llm-chat';
import type { Workspace } from '@johannes.latzel/llm-chat-workspace';
import type { ShellSessionManager } from '../lib/session-manager.js';
import {
    PermissionSystem,
    type PermissionCheckResult,
    workspaceForPath
} from '../lib/permission.js';
import { PermissionAction, PermissionDenyReason } from '../lib/types.js';
import type { ShellJob } from '../lib/types.js';

/** Prefix of the notice reporting an auto-created session id. */
const SESSION_NOTICE = '[shell_command] new session: ';
/** Opening delimiter wrapping command output when a session was auto-created. */
const OUTPUT_BEGIN = '[shell_command] --- begin output ---';
/** Closing delimiter wrapping command output when a session was auto-created. */
const OUTPUT_END = '[shell_command] --- end output ---';

/** Where a command runs and which workspace root its permissions resolve against. */
interface CommandTarget {
    /** True when no usable session id was given, so a session must be created. */
    create: boolean;
    /** Working directory the command runs in. */
    cwd: string;
    /** Resolved workspace root used for permission resolution. */
    workspaceRoot: string;
}

/**
 * Tool that executes a shell command in a persistent session.
 * Checks command permissions before execution. With `background=true` the
 * command is submitted as a queued job and the tool returns a job ID
 * immediately; poll `shell_job_status` for its progress and results.
 *
 * When `sessionId` is omitted or empty, a new session is created in the
 * current workspace once the command is allowed, and its id is reported in a
 * delimited notice ahead of the output. A non-empty id that is unknown or
 * tombstoned keeps its descriptive error and never spawns a session.
 */
export class ShellCommandTool extends Tool {
    constructor(
        private sessionManager: ShellSessionManager,
        private permissionSystem: PermissionSystem,
        private workspace: Workspace
    ) {
        super(
            'shell_command',
            'Executes a shell command in a persistent session. Supports pipes (|), logical operators (&&, ||), and redirects. ' +
                'When sessionId is omitted or empty, a new session is created in the current workspace and its id is returned in the result. ' +
                'Set background=true to submit the command as a queued job and return immediately with a job ID; poll shell_job_status / shell_jobs for results. ' +
                'Set timeout to override the max idle time (no output) in ms; larger values are capped by the server config. ' +
                'Set useCurrentWorkspace=true to run the command in the current workspace and permanently rebind the session to it.',
            new ToolParameters(
                {
                    command: ToolParameterProperty.string('The shell command to execute.'),
                    sessionId: ToolParameterProperty.string(
                        'The session ID from shell_create. When omitted or empty, a new session is created in the current workspace and its id is returned in the result.'
                    ),
                    useCurrentWorkspace: ToolParameterProperty.boolean(
                        'When true, run the command in the current workspace and permanently bind this session to that workspace.'
                    ),
                    background: ToolParameterProperty.boolean(
                        'When true, submit the command as a background job, return immediately with a jobId, and continue with other work. Poll shell_job_status for the result.'
                    ),
                    timeout: ToolParameterProperty.integer(
                        'Max idle time in ms (no stdout/stderr output) before the command is killed. Defaults to the configured foreground or background timeout; larger values are capped by the server config.'
                    )
                },
                ['command']
            )
        );
    }

    protected async onExecute(args: Record<string, unknown>): Promise<PartialToolResult> {
        this.validateRequiredParams(args, ['command']);

        const command = args['command'] as string;
        const rawSessionId = args['sessionId'];
        const providedId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
        const useCurrentWorkspace = args['useCurrentWorkspace'] === true;
        const background = args['background'] === true;
        const timeout = this.parseTimeout(args['timeout']);

        // Resolve the cwd and permission root. A non-empty unknown id throws here,
        // before anything is created; an absent id resolves to the current workspace.
        const target = await this.resolveTarget(providedId, useCurrentWorkspace);

        // Check permissions against the effective workspace root before creating a session
        const permission = this.permissionSystem.check(command, target.workspaceRoot);
        if (permission.action === PermissionAction.Deny) {
            const deniedSubs = this.getDeniedSubcommands(permission, target.workspaceRoot);
            const message =
                deniedSubs.length > 0
                    ? `Permission denied for: ${deniedSubs.join(', ')}`
                    : 'Permission denied';
            const reason =
                permission.denyReason === PermissionDenyReason.WriteAccess
                    ? ` (requires write access to ${target.workspaceRoot})`
                    : '';
            return { result: message + reason, status: ResultStatus.Error };
        }

        // The command is allowed: create the session now, or rebind an existing one.
        let sessionId = providedId;
        let createdId: string | undefined;
        if (target.create) {
            sessionId = await this.sessionManager.createSession(target.cwd);
            createdId = sessionId;
        } else if (useCurrentWorkspace) {
            await this.sessionManager.rebindSession(sessionId, target.workspaceRoot, target.cwd);
        }

        if (background) {
            const job = await this.sessionManager.submitCommand(sessionId, command, {
                cwd: target.cwd,
                ...(timeout !== undefined ? { timeout } : {})
            });
            return {
                result: this.formatJobSubmitted(job, createdId),
                status: ResultStatus.Success
            };
        }

        // Execute command (blocks until the shell gets to it, running queued jobs first)
        const result = await this.sessionManager.executeCommand(sessionId, command, {
            cwd: target.cwd,
            ...(timeout !== undefined ? { timeout } : {})
        });

        // Format output
        const output = this.formatOutput(result);
        const status = result.exitCode === 0 ? ResultStatus.Success : ResultStatus.Error;

        return {
            result: createdId !== undefined ? this.withSessionNotice(createdId, output) : output,
            status
        };
    }

    /** Only finite, positive numbers are honored; anything else falls back to the default. */
    private parseTimeout(value: unknown): number | undefined {
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
            return undefined;
        }
        return value;
    }

    /**
     * Resolve the cwd and workspace root a command targets. When no usable id
     * was given, the command runs in the current workspace and a session is
     * created; an explicit id keeps its bound cwd/root unless
     * `useCurrentWorkspace` moves it to the current workspace.
     */
    private async resolveTarget(
        providedId: string,
        useCurrentWorkspace: boolean
    ): Promise<CommandTarget> {
        if (providedId.length === 0) {
            return {
                create: true,
                cwd: this.workspace.currentPath,
                workspaceRoot: this.currentWorkspaceRoot()
            };
        }
        if (!useCurrentWorkspace) {
            return {
                create: false,
                cwd: await this.sessionManager.getSessionCwd(providedId),
                workspaceRoot: await this.sessionManager.getSessionWorkspaceRoot(providedId)
            };
        }
        return {
            create: false,
            cwd: this.workspace.currentPath,
            workspaceRoot: this.currentWorkspaceRoot()
        };
    }

    /** Deepest workspace access root containing the current workspace path. */
    private currentWorkspaceRoot(): string {
        const roots = this.workspace.getAccesses().map((a) => a.path);
        return workspaceForPath(this.workspace.currentPath, roots);
    }

    private getDeniedSubcommands(
        permission: PermissionCheckResult,
        workspaceRoot: string
    ): string[] {
        // Re-check each raw fragment (core + redirects) to find which are denied
        const denied: string[] = [];
        for (const fragment of permission.fragments) {
            const check = this.permissionSystem.check(fragment.raw, workspaceRoot);
            if (check.action === PermissionAction.Deny) {
                denied.push(fragment.raw);
            }
        }
        return denied;
    }

    /** Wrap output with the created-session notice and delimiters the model can spot. */
    private withSessionNotice(sessionId: string, output: string): string {
        return `${SESSION_NOTICE}${sessionId}\n${OUTPUT_BEGIN}\n${output}\n${OUTPUT_END}`;
    }

    private formatJobSubmitted(job: ShellJob, createdId?: string): string {
        const message = `Background job ${job.id} submitted (status: ${job.status}, queue position ${job.position}). Poll shell_job_status with this jobId for results.`;
        return createdId !== undefined ? `${SESSION_NOTICE}${createdId}\n${message}` : message;
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
