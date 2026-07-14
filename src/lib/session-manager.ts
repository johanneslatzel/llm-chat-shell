import { Mutex } from 'async-mutex';
import type { Workspace } from '@johannes.latzel/llm-chat-workspace';
import { ShellJobStatus } from './types.js';
import type {
    ShellCommandResult,
    ShellExecutor,
    ShellExecutorFactory,
    ShellJob,
    ShellSessionInfo
} from './types.js';
import type { ShellConfiguration } from './config.js';
import { JobRegistry } from './job-registry.js';
import { SessionRegistry } from './session-registry.js';
import { SessionQueue } from './session-queue.js';

export type { ShellExecutorFactory, ShellSessionDeathReason } from './types.js';

/**
 * Manages shell session lifecycle as a registry of {@link ShellExecutor} instances.
 * Each session is its own executor. Tracks active sessions and enforces limits.
 *
 * The class composes a {@link JobRegistry} (bounded store of every job, live
 * or finished), a {@link SessionRegistry} (live sessions plus tombstones), and
 * a {@link SessionQueue} (the per-session FIFO worker loop), and coordinates
 * them with the idle-expiry sweeper and the teardown of dead or closed
 * sessions.
 *
 * Because a shell executes a single command at a time, every command submitted to
 * a session (foreground or background) is queued in FIFO order and run by a single
 * per-session worker loop. Foreground calls block until their job completes;
 * background submissions return immediately with a {@link ShellJob} to poll.
 * Finished jobs stay queryable by ID in a bounded registry, even after their
 * session dies.
 *
 * Sessions idle for longer than `config.sessionTimeout` are expired by a background
 * sweeper, and sessions whose underlying process died are pruned, so `maxSessions`
 * slots are never permanently lost. Sessions with queued or running jobs are never
 * expired. Dead sessions are recorded as tombstones so stale session IDs keep
 * producing descriptive errors instead of a bare "not found".
 *
 * The manager owns the single mutex that gates the operations which span an
 * `await`: session creation (its factory call is awaited while holding the
 * lock, so concurrent creates cannot both pass the `maxSessions` check),
 * teardown, and expiry are serialized against each other and against
 * submissions. The components themselves are lock-free — their operations are
 * synchronous and therefore atomic under the single-threaded event loop, so
 * they interleave safely with the manager's mutex-protected blocks. The
 * worker loop runs outside the mutex by design: its per-job bookkeeping is a
 * single synchronous block, and the session's `processing` flag guarantees at
 * most one worker. Executor close is single-owner: whoever removes a session
 * from the registry closes its executor (a teardown caller, or the worker on
 * a naturally dead session).
 */
export class ShellSessionManager {
    private sessions: SessionRegistry;
    private jobs = new JobRegistry();
    private queue: SessionQueue;
    private mutex = new Mutex();
    private sweeper: NodeJS.Timeout | null = null;

    constructor(
        factory: ShellExecutorFactory,
        private config: ShellConfiguration,
        readonly workspace: Workspace
    ) {
        this.sessions = new SessionRegistry(factory, config, workspace, this.jobs);
        this.queue = new SessionQueue(this.sessions, this.jobs);
        this.startSweeper();
    }

    /**
     * Create a new shell session.
     * @param cwd - Optional working directory for this session. Must resolve to a subpath
     *              of the configured workspace access dirs. Symlinks are resolved when the
     *              workspace has `resolveSymlinks` enabled.
     * @returns The session ID.
     * @throws Error if max sessions reached or cwd is outside the accessible directories.
     */
    async createSession(cwd?: string): Promise<string> {
        return this.mutex.runExclusive(() => this.sessions.create(cwd));
    }

    /**
     * Return the workspace root a session is currently bound to.
     * @throws Error if session does not exist.
     */
    async getSessionWorkspaceRoot(sessionId: string): Promise<string> {
        return this.mutex.runExclusive(() => this.sessions.getWorkspaceRoot(sessionId));
    }

    /**
     * Return the working directory a session's jobs run in.
     * @throws Error if session does not exist.
     */
    async getSessionCwd(sessionId: string): Promise<string> {
        return this.mutex.runExclusive(() => this.sessions.getCwd(sessionId));
    }

    /**
     * Permanently rebind a session to a different workspace root and working
     * directory. Subsequent permission checks use the new root and jobs run in
     * the new cwd.
     * @throws Error if session does not exist.
     */
    async rebindSession(sessionId: string, workspaceRoot: string, cwd: string): Promise<void> {
        await this.mutex.runExclusive(() => this.sessions.rebind(sessionId, workspaceRoot, cwd));
    }

    /**
     * Run a command in the foreground: enqueue it and block until the shell gets
     * to it and it completes (or fails). Commands already queued on the same
     * session (including background jobs) run first.
     *
     * @param options - `cwd` is the working directory the command runs in
     *                  (defaults to the session's cwd); `timeout` overrides the
     *                  idle timeout (ms, capped at `config.maxTimeout`); omitted
     *                  uses `ctrlCTimeout`.
     * @throws Error if the session does not exist or the job failed before running.
     */
    async executeCommand(
        sessionId: string,
        command: string,
        options?: { timeout?: number; cwd?: string }
    ): Promise<ShellCommandResult> {
        const cwd = options?.cwd ?? (await this.getSessionCwd(sessionId));
        const record = await this.mutex.runExclusive(() =>
            this.queue.submit(
                sessionId,
                command,
                this.config.resolveIdleTimeout(false, options?.timeout),
                cwd
            )
        );
        await record.done;
        if (record.status === ShellJobStatus.Failed) {
            throw new Error(record.error!);
        }
        return {
            stdout: record.stdout!,
            stderr: record.stderr!,
            exitCode: record.exitCode!,
            timedOut: record.timedOut!,
            sessionAlive: record.sessionAlive!,
            ...(record.timedOut === true ? { idleTimeoutMs: record.idleTimeoutMs } : {})
        };
    }

    /**
     * Submit a command to run in the background and return immediately with a
     * {@link ShellJob}. The job runs when the shell is free (FIFO queue per
     * session); poll {@link getJobStatus} for progress and results.
     *
     * @param options - `cwd` is the working directory the job runs in
     *                  (defaults to the session's cwd); `timeout` overrides the
     *                  idle timeout (ms, capped at `config.maxTimeout`); omitted
     *                  uses `backgroundTimeout`.
     * @throws Error if the session does not exist.
     */
    async submitCommand(
        sessionId: string,
        command: string,
        options?: { timeout?: number; cwd?: string }
    ): Promise<ShellJob> {
        const cwd = options?.cwd ?? (await this.getSessionCwd(sessionId));
        return this.mutex.runExclusive(() =>
            this.queue.submit(
                sessionId,
                command,
                this.config.resolveIdleTimeout(true, options?.timeout),
                cwd
            )
        );
    }

    /**
     * Return the current status and (once finished) results of a job.
     * @throws Error if the job was evicted from the registry or never existed.
     */
    async getJobStatus(jobId: string): Promise<ShellJob> {
        return this.mutex.runExclusive(() => {
            const job = this.jobs.require(jobId);
            const snapshot: ShellJob = { ...job };
            if (job.status === ShellJobStatus.Queued) {
                const position = this.sessions.queuePosition(job.sessionId, job.id);
                if (position !== undefined) {
                    snapshot.position = position;
                }
            }
            return snapshot;
        });
    }

    /**
     * List the retained jobs submitted to a session, oldest first. Works even
     * after the session has died, as long as its jobs are still in the registry.
     * @throws Error if the session is unknown and has no retained jobs.
     */
    async listJobs(sessionId: string): Promise<ShellJob[]> {
        return this.mutex.runExclusive(() => {
            const jobs = this.jobs.listForSession(sessionId);
            if (jobs.length === 0 && !this.sessions.has(sessionId)) {
                throw new Error(this.sessions.notFoundMessage(sessionId));
            }
            return jobs;
        });
    }

    /**
     * Snapshot the active shell sessions with their current load. Pending
     * (queued) jobs are counted; the running job (if any) is identified.
     */
    async listSessions(): Promise<ShellSessionInfo[]> {
        return this.mutex.runExclusive(() => {
            const runningBySession = new Map<string, string>();
            for (const job of this.jobs.listAll()) {
                if (job.status === ShellJobStatus.Running) {
                    runningBySession.set(job.sessionId, job.id);
                }
            }
            return this.sessions.entries().map(([id, entry]) => {
                const runningJobId = runningBySession.get(id);
                return {
                    id,
                    workspaceRoot: entry.workspaceRoot,
                    queued: entry.queue.length,
                    ...(runningJobId !== undefined ? { runningJobId } : {})
                };
            });
        });
    }

    /**
     * List every retained job across all sessions, oldest first. Jobs that
     * completed or failed remain in the registry until evicted.
     */
    async listAllJobs(): Promise<ShellJob[]> {
        return this.mutex.runExclusive(() => this.jobs.listAll());
    }

    /**
     * Close a shell session and clean up its executor. Queued jobs fail with a
     * descriptive reason; the session is tombstoned so later references produce
     * a descriptive error.
     */
    async closeSession(sessionId: string): Promise<void> {
        const executor = await this.mutex.runExclusive(() =>
            this.sessions.teardown(
                sessionId,
                'closed',
                'the session was closed before the job could run'
            )
        );
        if (executor !== undefined) {
            await executor.close();
        }
    }

    /**
     * Close all active sessions and stop the idle-expiry sweeper.
     */
    async close(): Promise<void> {
        this.stopSweeper();
        const executors = await this.mutex.runExclusive(() => {
            const execs = this.sessions.values().map((entry) => entry.executor);
            for (const entry of this.sessions.values()) {
                this.jobs.failAll(
                    entry.queue,
                    'the session manager was disposed before the job could run'
                );
            }
            this.sessions.clear();
            return execs;
        });
        await Promise.all(executors.map((exec) => exec.close()));
    }

    /** Alias for {@link close}: closes all sessions and stops background timers. */
    async dispose(): Promise<void> {
        await this.close();
    }

    /**
     * Expire sessions that have been idle (no queued or running jobs) for at least
     * `config.sessionTimeout`. Sessions with pending jobs are never expired.
     */
    private async expireIdleSessions(): Promise<void> {
        const sessionTimeout = this.config.sessionTimeout;
        if (!Number.isFinite(sessionTimeout) || sessionTimeout <= 0) {
            return;
        }
        const now = Date.now();
        const expiredExecutors: ShellExecutor[] = await this.mutex.runExclusive(() => {
            const executors: ShellExecutor[] = [];
            for (const [id, entry] of this.sessions.expired(now, sessionTimeout)) {
                executors.push(entry.executor);
                this.sessions.teardown(
                    id,
                    'expired',
                    'the session expired before the job could run'
                );
            }
            return executors;
        });
        await Promise.all(expiredExecutors.map((exec) => exec.close()));
    }

    /** Start the idle-expiry sweeper, ticking every sessionTimeout/2 (min 1s). */
    private startSweeper(): void {
        this.stopSweeper();
        const sessionTimeout = this.config.sessionTimeout;
        if (!Number.isFinite(sessionTimeout) || sessionTimeout <= 0) {
            return;
        }
        const interval = Math.max(1000, Math.floor(sessionTimeout / 2));
        this.sweeper = setInterval(() => {
            void this.expireIdleSessions().catch(() => {});
        }, interval);
        this.sweeper.unref();
    }

    private stopSweeper(): void {
        if (this.sweeper !== null) {
            clearInterval(this.sweeper);
            this.sweeper = null;
        }
    }
}
