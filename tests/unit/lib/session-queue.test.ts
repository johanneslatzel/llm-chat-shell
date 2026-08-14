import { describe, it, expect, vi } from 'vitest';
import { Workspace, DirectoryConfiguration, AccessType } from '@johannes.latzel/llm-chat-workspace';
import { SessionQueue } from '../../../src/lib/session-queue.js';
import { SessionRegistry } from '../../../src/lib/session-registry.js';
import { JobRegistry } from '../../../src/lib/job-registry.js';
import { ShellConfiguration } from '../../../src/lib/config.js';
import { ShellJobStatus } from '../../../src/lib/types.js';
import type { ShellCommandResult, ShellExecuteOptions, ShellExecutor, ShellExecutorFactory } from '../../../src/lib/types.js';

class MockExecutor implements ShellExecutor {
    closeCalls = 0;
    constructor(
        private readonly result: ShellCommandResult = {
            stdout: '',
            stderr: '',
            exitCode: 0,
            timedOut: false,
            sessionAlive: true
        },
        private readonly alive = true,
        private readonly aliveThrows = false
    ) {}
    async execute(): Promise<ShellCommandResult> {
        return this.result;
    }
    async close(): Promise<void> {
        this.closeCalls++;
    }
    isAlive(): boolean {
        if (this.aliveThrows) {
            throw new Error('aliveness exploded');
        }
        return this.alive;
    }
}

class ThrowingExecutor implements ShellExecutor {
    async execute(): Promise<ShellCommandResult> {
        throw new Error('boom');
    }
    async close(): Promise<void> {}
    isAlive(): boolean {
        return true;
    }
}

/** Executor that records calls and blocks until {@link complete} is called. */
class DeferredExecutor implements ShellExecutor {
    executeCalls: { command: string; cwd: string | undefined; idleTimeoutMs: number | undefined }[] = [];
    closeCalls = 0;
    private pendingResolve: ((result: ShellCommandResult) => void) | null = null;

    async execute(command: string, options?: ShellExecuteOptions): Promise<ShellCommandResult> {
        this.executeCalls.push({ command, cwd: options?.cwd, idleTimeoutMs: options?.idleTimeoutMs });
        return new Promise<ShellCommandResult>((resolve) => {
            this.pendingResolve = resolve;
        });
    }

    complete(result?: ShellCommandResult): void {
        this.pendingResolve?.(
            result ?? { stdout: '', stderr: '', exitCode: 0, timedOut: false, sessionAlive: true }
        );
        this.pendingResolve = null;
    }

    async close(): Promise<void> {
        this.closeCalls++;
    }

    isAlive(): boolean {
        return true;
    }
}

function createWorkspace(workspaceRoot: string): Workspace {
    return new Workspace(
        new DirectoryConfiguration(
            [{ type: AccessType.Write, path: workspaceRoot }],
            [],
            false,
            workspaceRoot
        )
    );
}

function makeQueue(factory: ShellExecutorFactory) {
    const config = new ShellConfiguration();
    config.maxSessions = 10;
    const workspace = createWorkspace(process.cwd());
    const jobs = new JobRegistry();
    const sessions = new SessionRegistry(factory, config, workspace, jobs);
    const queue = new SessionQueue(sessions, jobs);
    return { queue, sessions, jobs };
}

describe('SessionQueue', () => {
    it('submits a command, runs it, and resolves the job', async () => {
        const exec = new DeferredExecutor();
        const { queue, sessions } = makeQueue({ create: async () => exec });
        const sessionId = await sessions.create();

        const job = await queue.submit(sessionId, 'echo hi', 1000, '/work');
        await vi.waitFor(() => expect(exec.executeCalls).toHaveLength(1));
        expect(exec.executeCalls[0]).toEqual({ command: 'echo hi', cwd: '/work', idleTimeoutMs: 1000 });
        expect(job.status).toBe(ShellJobStatus.Running);

        exec.complete();
        await job.done;
        expect(job.status).toBe(ShellJobStatus.Completed);
        expect(job.exitCode).toBe(0);
        expect(job.sessionAlive).toBe(true);
    });

    it('runs jobs one at a time in FIFO order', async () => {
        const exec = new DeferredExecutor();
        const { queue, sessions } = makeQueue({ create: async () => exec });
        const sessionId = await sessions.create();

        const j1 = await queue.submit(sessionId, 'job1', 1000, '/work');
        const j2 = await queue.submit(sessionId, 'job2', 1000, '/work');
        const j3 = await queue.submit(sessionId, 'job3', 1000, '/work');
        await vi.waitFor(() => expect(exec.executeCalls).toHaveLength(1));

        exec.complete();
        await j1.done;
        await vi.waitFor(() => expect(exec.executeCalls).toHaveLength(2));
        expect(exec.executeCalls[1]?.command).toBe('job2');

        exec.complete();
        await j2.done;
        await vi.waitFor(() => expect(exec.executeCalls).toHaveLength(3));
        expect(exec.executeCalls[2]?.command).toBe('job3');

        exec.complete();
        await j3.done;
        expect(j3.status).toBe(ShellJobStatus.Completed);
    });

    it('fails a job whose executor throws and keeps the session alive', async () => {
        const { queue, sessions } = makeQueue({ create: async () => new ThrowingExecutor() });
        const sessionId = await sessions.create();

        const job = await queue.submit(sessionId, 'bad', 1000, '/work');
        await job.done;
        expect(job.status).toBe(ShellJobStatus.Failed);
        expect(job.error).toBe('boom');
        expect(sessions.has(sessionId)).toBe(true);
    });

    it('fails with an unexpected-failure message when the aliveness check throws', async () => {
        const exec = new MockExecutor(undefined, true, true);
        const { queue, sessions } = makeQueue({ create: async () => exec });
        const sessionId = await sessions.create();

        const job = await queue.submit(sessionId, 'weird', 1000, '/work');
        await job.done;
        expect(job.status).toBe(ShellJobStatus.Failed);
        expect(job.error).toContain('unexpected failure');
        expect(job.error).toContain('aliveness exploded');
        expect(sessions.has(sessionId)).toBe(true);
    });

    it('tombstones the session and fails pending jobs when the shell dies', async () => {
        const exec = new DeferredExecutor();
        const { queue, sessions } = makeQueue({ create: async () => exec });
        const sessionId = await sessions.create();

        const running = await queue.submit(sessionId, 'killer', 1000, '/work');
        const pending = await queue.submit(sessionId, 'pending', 1000, '/work');
        await vi.waitFor(() => expect(exec.executeCalls).toHaveLength(1));

        exec.complete({ stdout: '', stderr: '', exitCode: 137, timedOut: false, sessionAlive: false });
        await running.done;
        await pending.done;

        expect(running.status).toBe(ShellJobStatus.Completed);
        expect(running.sessionAlive).toBe(false);
        expect(pending.status).toBe(ShellJobStatus.Failed);
        expect(pending.error).toBe('the session died before the job could run');
        expect(sessions.has(sessionId)).toBe(false);
        expect(sessions.notFoundMessage(sessionId)).toContain('underlying shell process exited');
        expect(exec.closeCalls).toBe(1);
    });

    it('records a timeout death when the result reports a timeout', async () => {
        const exec = new DeferredExecutor();
        const { queue, sessions } = makeQueue({ create: async () => exec });
        const sessionId = await sessions.create();

        const job = await queue.submit(sessionId, 'slow', 1000, '/work');
        await vi.waitFor(() => expect(exec.executeCalls).toHaveLength(1));
        exec.complete({ stdout: '', stderr: '', exitCode: -1, timedOut: true, sessionAlive: false });
        await job.done;

        expect(job.status).toBe(ShellJobStatus.Completed);
        expect(job.timedOut).toBe(true);
        expect(sessions.notFoundMessage(sessionId)).toContain(
            'was killed because a command produced no output'
        );
    });

    it('treats a dead executor as a process-exited death even when the result claims it is alive', async () => {
        const exec = new MockExecutor(undefined, false);
        const { queue, sessions } = makeQueue({ create: async () => exec });
        const sessionId = await sessions.create();

        const job = await queue.submit(sessionId, 'died', 1000, '/work');
        await job.done;
        expect(job.status).toBe(ShellJobStatus.Completed);
        expect(sessions.notFoundMessage(sessionId)).toContain('underlying shell process exited');
        expect(exec.closeCalls).toBe(1);
    });

    it('keeps an existing tombstone and does not close when removed mid-run', async () => {
        const exec = new DeferredExecutor();
        const { queue, sessions } = makeQueue({ create: async () => exec });
        const sessionId = await sessions.create();

        const job = await queue.submit(sessionId, 'ghost', 1000, '/work');
        await vi.waitFor(() => expect(exec.executeCalls).toHaveLength(1));
        const executor = sessions.teardown(sessionId, 'closed', 'closed mid-run')!;
        expect(executor).toBe(exec);
        exec.complete({ stdout: '', stderr: '', exitCode: 137, timedOut: false, sessionAlive: false });
        await job.done;

        expect(job.status).toBe(ShellJobStatus.Completed);
        expect(job.sessionAlive).toBe(false);
        expect(sessions.notFoundMessage(sessionId)).toContain('was closed');
        expect(exec.closeCalls).toBe(0);
        await executor.close();
        expect(exec.closeCalls).toBe(1);
    });

    it('runs each job in its own cwd, even after a prior job re-anchored elsewhere', async () => {
        const exec = new DeferredExecutor();
        const { queue, sessions } = makeQueue({ create: async () => exec });
        const sessionId = await sessions.create();

        const bg = await queue.submit(sessionId, 'job-bg', 1000, '/path-b');
        const fg = await queue.submit(sessionId, 'job-fg', 1000, '/path-a');
        await vi.waitFor(() => expect(exec.executeCalls).toHaveLength(1));
        expect(exec.executeCalls[0]).toEqual({ command: 'job-bg', cwd: '/path-b', idleTimeoutMs: 1000 });

        exec.complete();
        await bg.done;
        await vi.waitFor(() => expect(exec.executeCalls).toHaveLength(2));
        expect(exec.executeCalls[1]).toEqual({ command: 'job-fg', cwd: '/path-a', idleTimeoutMs: 1000 });

        exec.complete();
        await fg.done;
        expect(fg.status).toBe(ShellJobStatus.Completed);
    });

    it('throws when submitting to an unknown session', async () => {
        const { queue } = makeQueue({ create: async () => new MockExecutor() });
        expect(() => queue.submit('nope', 'echo', 1000, '/work')).toThrow('Session not found: nope');
    });
});
