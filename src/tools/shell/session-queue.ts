import { randomUUID } from 'node:crypto';
import { ShellJobStatus } from './types.js';
import type { ShellCommandResult, ShellSessionDeathReason } from './types.js';
import { createJobRecord } from './job-registry.js';
import type { JobRecord, JobRegistry } from './job-registry.js';
import type { SessionEntry, SessionRegistry } from './session-registry.js';

/**
 * Runs the per-session FIFO job queue of a {@link ShellSessionManager}.
 *
 * Because a shell executes a single command at a time, every command submitted
 * to a session (foreground or background) is queued in FIFO order and executed
 * by a single per-session worker loop. Submitting starts the loop only when
 * the session is idle; while the loop drains, further submissions are picked
 * up by the running loop rather than starting a second one.
 *
 * Finished and failed jobs are recorded in the {@link JobRegistry} and their
 * completion promise is resolved, so foreground callers can await them.
 *
 * The queue holds no lock of its own: every transition it performs on the
 * session and job registries is synchronous and therefore atomic under the
 * single-threaded event loop. Submissions are serialized by the owning
 * manager, which wraps its calls into this queue in its mutex, so at most one
 * worker loop runs per session. The worker itself runs lock-free: its
 * per-job bookkeeping (dequeue, status transitions, and the death path) is a
 * single synchronous block and must never gain an `await` — an `await` there
 * would let a submission interleave with a mid-transition state. Executor
 * close is single-owner: the worker closes the executor only when it removed
 * the session itself; a manager teardown that removed the session first owns
 * the close. This class holds no session state of its own: sessions and jobs
 * live in the registries passed to the constructor.
 */
export class SessionQueue {
    constructor(
        private readonly sessions: SessionRegistry,
        private readonly jobs: JobRegistry
    ) {}

    /**
     * Enqueue a job and, when the session is idle, start the worker loop.
     * @returns The queued job record. Foreground callers await its `done`
     *          promise; background callers poll its status via the registries.
     * @throws Error if the session does not exist.
     */
    submit(sessionId: string, command: string, idleTimeoutMs: number): JobRecord {
        const record = createJobRecord({ id: randomUUID(), sessionId, command, idleTimeoutMs });
        const shouldStart = this.sessions.enqueue(sessionId, record);
        this.jobs.set(record);
        if (shouldStart) {
            void this.run(sessionId);
        }
        return record;
    }

    /**
     * Per-session worker loop: runs one queued job at a time until the queue
     * drains. Fetching the next job and clearing the `processing` flag happen
     * in one synchronous step, so a job enqueued while the queue is draining
     * always either gets picked up by this worker or triggers a fresh one —
     * never neither.
     */
    private async run(sessionId: string): Promise<void> {
        while (true) {
            const next = this.sessions.dequeue(sessionId);
            if (next === undefined) {
                return;
            }
            await this.execute(next.entry, next.job);
        }
    }

    /**
     * Execute a single job, updating its status and results. When the command
     * killed the shell (timeout) or the process exited, the session is removed,
     * tombstoned, and every still-queued job on it is failed — but only when
     * this worker still owns the session. If a manager teardown (close,
     * closeSession, expiry) removed the session first, that owner has already
     * tombstoned it and closed the executor; the worker leaves both alone.
     */
    private async execute(entry: SessionEntry, job: JobRecord): Promise<void> {
        try {
            job.status = ShellJobStatus.Running;
            job.startedAt = Date.now();
            entry.lastUsedMs = Date.now();

            let result: ShellCommandResult;
            try {
                result = await entry.executor.execute(job.command, {
                    idleTimeoutMs: job.idleTimeoutMs
                });
            } catch (error) {
                this.jobs.fail(job, (error as Error).message);
                return;
            }

            const died = result.timedOut || !result.sessionAlive || !entry.executor.isAlive();
            if (died) {
                const reason: ShellSessionDeathReason = result.timedOut
                    ? 'timeout'
                    : 'process-exited';
                const current = this.sessions.get(job.sessionId);
                if (current !== undefined && current === entry) {
                    this.sessions.remove(job.sessionId);
                    const pending = this.sessions.takeQueue(current);
                    this.jobs.failAll(pending, 'the session died before the job could run');
                    this.sessions.recordDeath(job.sessionId, reason);
                    // The executor may already be dead; never let a close failure surface here.
                    void entry.executor.close().catch(() => {});
                }
                this.jobs.finish(job, result);
                return;
            }

            this.jobs.finish(job, result);
            this.sessions.touch(job.sessionId);
        } catch (error) {
            this.jobs.fail(job, `unexpected failure: ${(error as Error).message}`);
        }
    }
}
