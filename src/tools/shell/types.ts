/** Permission action for shell commands. */
export enum PermissionAction {
    /** Allow the command to execute. */
    Allow = 'allow',
    /** Deny the command execution. */
    Deny = 'deny'
}

/** A single permission rule matching a glob pattern to an action. */
export interface PermissionRule {
    /** Glob pattern to match against subcommands (e.g. "git *"). */
    pattern: string;
    /** Action to take when the pattern matches. */
    action: PermissionAction;
}

/** Permission settings for a single workspace, keyed by its resolved root path. */
export interface WorkspacePermissions {
    /** Default action for commands not matching any rule in this workspace. */
    defaultPermission: PermissionAction;
    /** Permission rules applied in this workspace. */
    permissionRules: PermissionRule[];
}

/** Contents of the shell permission config file (strict JSON). */
export interface ShellConfigFile {
    /** Global permission settings (default: deny, no rules). */
    globalPermissions?: WorkspacePermissions;
    /** Per-workspace permission settings keyed by resolved workspace root path. */
    workspacePermissions?: Record<string, WorkspacePermissions>;
}

/** Result of executing a shell command. */
export interface ShellCommandResult {
    /** Standard output from the command. */
    stdout: string;
    /** Standard error from the command. */
    stderr: string;
    /** Exit code of the command (0 = success). */
    exitCode: number;
    /** True if the command was killed due to timeout. */
    timedOut: boolean;
    /** False if the bash process was killed (session is dead). */
    sessionAlive: boolean;
    /** Ms of inactivity (idle limit) after which the command was timed out; present when timedOut is true. */
    idleTimeoutMs?: number;
}

/** Execution state of a background job. */
export enum ShellJobStatus {
    /** Submitted and waiting for the shell to become free. */
    Queued = 'queued',
    /** Currently running in the shell. */
    Running = 'running',
    /** Finished and produced a result. */
    Completed = 'completed',
    /** Failed before producing a result (e.g. the session died). */
    Failed = 'failed'
}

/**
 * A background job submitted to a shell session. Jobs run one at a time per
 * session (the shell executes a single command at a time); submitted jobs are
 * queued in FIFO order. Completed and failed jobs remain queryable by ID until
 * they are evicted from the bounded job registry.
 */
export interface ShellJob {
    /** Globally unique job ID. */
    id: string;
    /** Session the job was submitted to. */
    sessionId: string;
    /** The command the job runs. */
    command: string;
    /** Current execution state. */
    status: ShellJobStatus;
    /** Effective idle timeout (ms) the job runs under. */
    idleTimeoutMs: number;
    /** Epoch ms when the job was submitted. */
    submittedAt: number;
    /** Epoch ms when the job started running; present once started. */
    startedAt?: number;
    /** Epoch ms when the job finished; present once completed or failed. */
    finishedAt?: number;
    /** Standard output; present when the job completed. */
    stdout?: string;
    /** Standard error; present when the job completed. */
    stderr?: string;
    /** Exit code; present when the job completed. */
    exitCode?: number;
    /** True when the job was killed due to timeout; present when the job completed. */
    timedOut?: boolean;
    /** False when the shell process died as a result of this job; present when the job completed. */
    sessionAlive?: boolean;
    /** Queue position (1-based) at submission; recomputed on read while queued. */
    position: number;
    /** Human-readable failure reason; present when the job failed. */
    error?: string;
}

/** Snapshot of an active shell session for administrative listing. */
export interface ShellSessionInfo {
    /** Globally unique session ID. */
    id: string;
    /** Workspace root the session is bound to for permission checks. */
    workspaceRoot: string;
    /** Number of jobs still queued (not yet started). */
    queued: number;
    /** ID of the currently running job, if one is executing. */
    runningJobId?: string;
}

/** Options for {@link ShellExecutor.execute}. */
export interface ShellExecuteOptions {
    /**
     * Idle timeout in ms (resets on stdout/stderr activity). When omitted or 0,
     * the executor's configured `ctrlCTimeout` applies.
     */
    idleTimeoutMs?: number;
}

/** Interface for a single persistent shell session. */
export interface ShellExecutor {
    /** Execute a command in this session. */
    execute(command: string, options?: ShellExecuteOptions): Promise<ShellCommandResult>;
    /**
     * Close this session and clean up resources. Idempotent: subsequent calls
     * are no-ops. Safe to call while {@link execute} is in flight — the running
     * command is terminated and its result reports `sessionAlive: false`.
     */
    close(): Promise<void>;
    /** True while the underlying shell process is still running. */
    isAlive(): boolean;
}

/** Factory interface for creating new {@link ShellExecutor} instances. */
export interface ShellExecutorFactory {
    /** Create a new shell executor (one session). */
    create(cwd?: string): Promise<ShellExecutor>;
}

/** Why a shell session is no longer usable. */
export type ShellSessionDeathReason = 'timeout' | 'expired' | 'process-exited' | 'closed';
