import { randomUUID } from 'node:crypto';
import type { Workspace } from '@johannes.latzel/llm-chat-workspace';
import type { ShellExecutor, ShellExecutorFactory, ShellSessionDeathReason } from './types.js';
import type { ShellConfiguration } from './config.js';
import type { JobRecord, JobRegistry } from './job-registry.js';
import { workspaceForPath } from './permission.js';

/** Description of a dead session, kept so stale session IDs still produce descriptive errors. */
export interface ShellSessionTombstone {
    reason: ShellSessionDeathReason;
    message: string;
}

/** Internal session entry binding an executor to its workspace root. */
export interface SessionEntry {
    executor: ShellExecutor;
    workspaceRoot: string;
    /** Working directory this session's jobs run in; the executor re-anchors here before each job. */
    cwd: string;
    /** Last time this session started or finished work; used by the idle-expiry sweeper. */
    lastUsedMs: number;
    /** Pending (queued) jobs in FIFO order — a shell runs a single command at a time. */
    queue: JobRecord[];
    /** True while the worker loop is draining this session's queue. */
    processing: boolean;
}

/**
 * Registry of live shell sessions plus the tombstones of dead ones. Owns the
 * session map, the FIFO job queue per session, and the bounded tombstone
 * store. It is a lock-free store: every operation is synchronous and
 * therefore atomic under the single-threaded event loop (`create` completes
 * its asynchronous factory call before writing any shared state). The owning
 * {@link ShellSessionManager} serializes access with its mutex, so this class
 * holds no lock of its own.
 *
 * Sessions are bound to a workspace root at creation. The binding is used for
 * permission checks; switching the active workspace never moves existing
 * sessions. Executor close is single-owner: the registry only returns the
 * executor (via {@link teardown}) or records a session as dead; it never
 * closes executors itself.
 */
export class SessionRegistry {
    /** Tombstones are kept in insertion order and evicted FIFO once the cap is reached. */
    private static readonly TOMBSTONE_CAP = 100;
    private static readonly DEATH_REASONS: Record<ShellSessionDeathReason, string> = {
        timeout: 'was killed because a command produced no output for too long',
        expired: 'expired after being idle for too long',
        'process-exited': 'is dead because the underlying shell process exited',
        closed: 'was closed'
    };

    private sessions = new Map<string, SessionEntry>();
    private tombstones = new Map<string, ShellSessionTombstone>();

    constructor(
        private readonly factory: ShellExecutorFactory,
        private readonly config: ShellConfiguration,
        private readonly workspace: Workspace,
        private readonly jobs: JobRegistry
    ) {}

    /**
     * Create a new shell session: prune dead sessions, enforce `maxSessions`,
     * then build an executor bound to the resolved cwd.
     * @param cwd - Optional working directory. Must resolve to a subpath of the
     *              configured workspace access dirs.
     * @returns The session ID.
     * @throws Error if max sessions reached or cwd is outside the accessible directories.
     */
    async create(cwd?: string): Promise<string> {
        const resolvedCwd = cwd !== undefined ? this.validateCwd(cwd) : this.workspace.currentPath;
        this.pruneDead();
        if (this.sessions.size >= this.config.maxSessions) {
            throw new Error(
                `Maximum sessions reached (${this.config.maxSessions}). Close a session before creating a new one.`
            );
        }
        const executor = await this.factory.create(resolvedCwd);
        const id = randomUUID();
        this.sessions.set(id, {
            executor,
            workspaceRoot: this.resolveWorkspaceRoot(resolvedCwd),
            cwd: resolvedCwd,
            lastUsedMs: Date.now(),
            queue: [],
            processing: false
        });
        return id;
    }

    /** Validate and resolve a cwd path against the accessible directories. */
    private validateCwd(inputCwd: string): string {
        const resolved = this.workspace.normalize(inputCwd);
        if (!this.workspace.canRead(resolved)) {
            throw new Error(
                `cwd must be within the configured working directory (${this.workspace.currentPath})`
            );
        }
        return resolved;
    }

    /** Resolve the workspace root (deepest containing access dir) for a cwd. */
    private resolveWorkspaceRoot(cwd: string): string {
        const roots = this.workspace.getAccesses().map((a) => a.path);
        return workspaceForPath(cwd, roots);
    }

    /** Get a session entry, or `undefined` when unknown or tombstoned. */
    get(sessionId: string): SessionEntry | undefined {
        return this.sessions.get(sessionId);
    }

    /** Require a session entry, throwing a descriptive error when unknown. */
    require(sessionId: string): SessionEntry {
        const entry = this.sessions.get(sessionId);
        if (entry === undefined) {
            throw new Error(this.notFoundMessage(sessionId));
        }
        return entry;
    }

    has(sessionId: string): boolean {
        return this.sessions.has(sessionId);
    }

    /** Remove and return a session entry, or `undefined` when unknown. */
    remove(sessionId: string): SessionEntry | undefined {
        const entry = this.sessions.get(sessionId);
        this.sessions.delete(sessionId);
        return entry;
    }

    /** All live sessions as `[id, entry]` pairs. */
    entries(): [string, SessionEntry][] {
        return [...this.sessions.entries()];
    }

    /** All live session entries. */
    values(): SessionEntry[] {
        return [...this.sessions.values()];
    }

    clear(): void {
        this.sessions.clear();
    }

    /**
     * Return the workspace root a session is currently bound to.
     * @throws Error if session does not exist.
     */
    getWorkspaceRoot(sessionId: string): string {
        return this.require(sessionId).workspaceRoot;
    }

    /**
     * Return the working directory a session's jobs run in.
     * @throws Error if session does not exist.
     */
    getCwd(sessionId: string): string {
        return this.require(sessionId).cwd;
    }

    /**
     * Permanently rebind a session to a different workspace root and working
     * directory. Subsequent permission checks use the new root and jobs run in
     * the new cwd.
     * @throws Error if session does not exist.
     */
    rebind(sessionId: string, workspaceRoot: string, cwd: string): void {
        const entry = this.require(sessionId);
        entry.workspaceRoot = workspaceRoot;
        entry.cwd = cwd;
    }

    /**
     * Enqueue a job and start the worker loop when the session is idle.
     * Sets the job's queue position, records activity, and marks the session
     * as processing. Synchronous and therefore atomic on its own.
     * @returns True if the caller should start the worker loop.
     */
    enqueue(sessionId: string, record: JobRecord): boolean {
        const entry = this.sessions.get(sessionId);
        if (entry === undefined) {
            throw new Error(this.notFoundMessage(sessionId));
        }
        record.position = entry.queue.length + 1;
        entry.queue.push(record);
        entry.lastUsedMs = Date.now();
        const shouldStart = !entry.processing;
        entry.processing = true;
        return shouldStart;
    }

    /**
     * Shift the next job off a session's queue. Clearing the `processing` flag
     * happens here too, so a job enqueued while the queue is draining always
     * either gets picked up by the current worker or triggers a fresh one.
     * @returns The entry and next job, or `undefined` when the session is gone
     *          or its queue has drained.
     */
    dequeue(sessionId: string): { entry: SessionEntry; job: JobRecord } | undefined {
        const entry = this.sessions.get(sessionId);
        if (entry === undefined) {
            return undefined;
        }
        const job = entry.queue.shift();
        if (job === undefined) {
            entry.processing = false;
            entry.lastUsedMs = Date.now();
            return undefined;
        }
        return { entry, job };
    }

    /** Current 1-based queue position of a queued job, or `undefined` if not queued. */
    queuePosition(sessionId: string, jobId: string): number | undefined {
        const entry = this.sessions.get(sessionId);
        if (entry === undefined) {
            return undefined;
        }
        const index = entry.queue.findIndex((queued) => queued.id === jobId);
        return index >= 0 ? index + 1 : undefined;
    }

    /** Record session activity; a no-op when the session is gone. */
    touch(sessionId: string): void {
        const entry = this.sessions.get(sessionId);
        if (entry !== undefined) {
            entry.lastUsedMs = Date.now();
        }
    }

    /** Remove a session's queue and return its still-queued jobs. */
    takeQueue(entry: SessionEntry): JobRecord[] {
        const rest = entry.queue;
        entry.queue = [];
        return rest;
    }

    /** Fail every still-queued job of a session with the given reason. */
    failPending(entry: SessionEntry, reason: string): void {
        this.jobs.failAll(entry.queue, reason);
        entry.queue = [];
    }

    /**
     * Remove a session, tombstone it, and fail its pending jobs. When
     * `expected` is given, only tears down if the live entry still is that one.
     * @returns The session's executor for the caller to close, or `undefined`
     *          when the session was already gone (or no longer the expected entry).
     */
    teardown(
        sessionId: string,
        reason: ShellSessionDeathReason,
        failReason: string,
        expected?: SessionEntry
    ): ShellExecutor | undefined {
        const current = this.sessions.get(sessionId);
        if (current === undefined || (expected !== undefined && current !== expected)) {
            return undefined;
        }
        this.sessions.delete(sessionId);
        this.recordDeath(sessionId, reason);
        this.failPending(current, failReason);
        return current.executor;
    }

    /** Live sessions idle for at least `sessionTimeout` with no pending work. */
    expired(now: number, sessionTimeout: number): [string, SessionEntry][] {
        const expired: [string, SessionEntry][] = [];
        for (const [id, entry] of this.sessions) {
            if (
                !entry.processing &&
                entry.queue.length === 0 &&
                now - entry.lastUsedMs >= sessionTimeout
            ) {
                expired.push([id, entry]);
            }
        }
        return expired;
    }

    /**
     * Record a dead session as a tombstone so stale IDs produce a descriptive
     * error (with the relevant configured timeout value) instead of a bare
     * "Session not found". Tombstones are bounded FIFO.
     */
    recordDeath(sessionId: string, reason: ShellSessionDeathReason): void {
        let detail = '';
        if (reason === 'timeout') {
            detail = ` (idle limit: ${this.config.ctrlCTimeout}ms)`;
        } else if (reason === 'expired') {
            detail = ` (idle limit: ${this.config.sessionTimeout}ms)`;
        }
        const message = `Session ${sessionId} ${SessionRegistry.DEATH_REASONS[reason]}${detail}. Create a new session to continue.`;
        this.tombstones.set(sessionId, { reason, message });
        while (this.tombstones.size > SessionRegistry.TOMBSTONE_CAP) {
            this.tombstones.delete(this.tombstones.keys().next().value!);
        }
    }

    /** Descriptive "not found" error for a session ID, preferring a tombstone message. */
    notFoundMessage(sessionId: string): string {
        const tombstone = this.tombstones.get(sessionId);
        if (tombstone !== undefined) {
            return tombstone.message;
        }
        return `Session not found: ${sessionId}`;
    }

    /**
     * Remove sessions whose underlying process has exited, freeing their
     * `maxSessions` slot. Queued jobs fail and the session is tombstoned.
     */
    private pruneDead(): void {
        for (const [id, entry] of this.sessions) {
            if (!entry.executor.isAlive()) {
                this.teardown(
                    id,
                    'process-exited',
                    'the shell process exited before the job could run'
                );
            }
        }
    }
}
