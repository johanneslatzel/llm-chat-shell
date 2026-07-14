import { ShellJobStatus } from './types.js';
import type { ShellCommandResult, ShellJob } from './types.js';

/** Internal job record: a {@link ShellJob} plus completion signalling. */
export interface JobRecord extends ShellJob {
    /** Resolves when the job finishes (completes or fails). */
    done: Promise<void>;
    resolveDone: () => void;
}

/** Build a new queued job record with its completion promise. */
export function createJobRecord(input: {
    id: string;
    sessionId: string;
    command: string;
    idleTimeoutMs: number;
}): JobRecord {
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
    });
    return {
        ...input,
        status: ShellJobStatus.Queued,
        submittedAt: Date.now(),
        position: 0,
        done,
        resolveDone
    };
}

/**
 * Bounded registry of every job submitted to any session. Finished jobs stay
 * queryable by ID until the oldest are evicted FIFO beyond the cap; pending
 * (queued or running) jobs are never evicted.
 *
 * Owns no session knowledge: it stores records, reports their status, and
 * applies a single rule about what may be dropped. All mutations are
 * synchronous and therefore atomic under the single-threaded event loop; no
 * lock is required.
 */
export class JobRegistry {
    /** Finished jobs retained in the registry; the oldest are evicted FIFO beyond this cap. */
    private static readonly JOB_CAP = 200;

    private jobs = new Map<string, JobRecord>();

    /** Add a job record (created via {@link createJobRecord}). */
    set(job: JobRecord): void {
        this.jobs.set(job.id, job);
    }

    /** Get a job record by ID, or `undefined` when unknown or evicted. */
    get(jobId: string): JobRecord | undefined {
        return this.jobs.get(jobId);
    }

    /** Require a job record by ID. */
    require(jobId: string): JobRecord {
        const job = this.jobs.get(jobId);
        if (job === undefined) {
            throw new Error(`Job not found: ${jobId}`);
        }
        return job;
    }

    /** Record a completed job's result in the registry. */
    finish(job: JobRecord, result: ShellCommandResult): void {
        job.status = ShellJobStatus.Completed;
        job.finishedAt = Date.now();
        job.stdout = result.stdout;
        job.stderr = result.stderr;
        job.exitCode = result.exitCode;
        job.timedOut = result.timedOut;
        job.sessionAlive = result.sessionAlive;
        this.set(job);
        this.evictFinished();
        job.resolveDone();
    }

    /** Record a failed job's reason in the registry. */
    fail(job: JobRecord, error: string): void {
        job.status = ShellJobStatus.Failed;
        job.finishedAt = Date.now();
        job.error = error;
        this.set(job);
        this.evictFinished();
        job.resolveDone();
    }

    /** Fail every job in the given list. */
    failAll(jobs: Iterable<JobRecord>, error: string): void {
        for (const job of jobs) {
            this.fail(job, error);
        }
    }

    /**
     * Evict the oldest finished jobs beyond the cap in one forward pass.
     * `set()` keeps insertion order even when re-setting an existing key, so
     * scanning from the start finds the oldest-submitted finished jobs first
     * and preserves FIFO eviction. Jobs that are still queued or running are
     * skipped, and the pass stops once the over-cap count has been evicted.
     */
    evictFinished(): void {
        const excess = this.jobs.size - JobRegistry.JOB_CAP;
        if (excess <= 0) {
            return;
        }
        let evicted = 0;
        for (const [id, job] of this.jobs) {
            if (evicted === excess) {
                break;
            }
            if (job.status !== ShellJobStatus.Queued && job.status !== ShellJobStatus.Running) {
                this.jobs.delete(id);
                evicted++;
            }
        }
    }

    /** Snapshot copies of a session's retained jobs, oldest first. */
    listForSession(sessionId: string): ShellJob[] {
        const jobs: ShellJob[] = [];
        for (const job of this.jobs.values()) {
            if (job.sessionId === sessionId) {
                jobs.push({ ...job });
            }
        }
        jobs.sort((a, b) => a.submittedAt - b.submittedAt);
        return jobs;
    }

    /** Snapshot copies of every retained job, oldest first. */
    listAll(): ShellJob[] {
        const jobs = [...this.jobs.values()].map((job) => ({ ...job }));
        jobs.sort((a, b) => a.submittedAt - b.submittedAt);
        return jobs;
    }
}
