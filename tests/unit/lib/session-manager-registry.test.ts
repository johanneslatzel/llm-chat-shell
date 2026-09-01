import { describe, it, expect, afterEach, vi } from 'vitest';
import { Workspace, DirectoryConfiguration, AccessType } from '@johannes.latzel/llm-chat-workspace';
import { ShellSessionManager } from '../../../src/lib/session-manager.js';
import { ShellConfiguration } from '../../../src/lib/config.js';
import {
    ShellJobStatus,
    type ShellCommandResult,
    type ShellExecuteOptions,
    type ShellExecutor
} from '../../../src/lib/types.js';

class MockExecutor implements ShellExecutor {
    constructor(
        private readonly result: ShellCommandResult = {
            stdout: '',
            stderr: '',
            exitCode: 0,
            timedOut: false,
            sessionAlive: true
        },
        private readonly alive = true,
        private readonly closeError = false
    ) {}
    async execute(_command: string): Promise<ShellCommandResult> {
        return this.result;
    }
    async close(): Promise<void> {
        if (this.closeError) {
            throw new Error('close failed');
        }
    }
    isAlive(): boolean {
        return this.alive;
    }
}

/** Executor that records calls and blocks until {@link complete} is called. */
class DeferredExecutor implements ShellExecutor {
    executeCalls: { command: string; idleTimeoutMs: number | undefined }[] = [];
    private pendingResolve: ((result: ShellCommandResult) => void) | null = null;

    constructor(
        private readonly defaultResult: ShellCommandResult = {
            stdout: '',
            stderr: '',
            exitCode: 0,
            timedOut: false,
            sessionAlive: true
        }
    ) {}

    async execute(command: string, options?: ShellExecuteOptions): Promise<ShellCommandResult> {
        this.executeCalls.push({ command, idleTimeoutMs: options?.idleTimeoutMs });
        return new Promise<ShellCommandResult>((resolve) => {
            this.pendingResolve = resolve;
        });
    }

    complete(result?: ShellCommandResult): void {
        this.pendingResolve?.(result ?? this.defaultResult);
        this.pendingResolve = null;
    }

    async close(): Promise<void> {}

    isAlive(): boolean {
        return true;
    }
}

function createWorkspace(workspaceRoot: string, resolveSymlinks = false): Workspace {
    return new Workspace(
        new DirectoryConfiguration(
            [{ type: AccessType.Write, path: workspaceRoot }],
            [],
            resolveSymlinks,
            workspaceRoot
        )
    );
}

function createConfig(maxSessions = 10): ShellConfiguration {
    const cfg = new ShellConfiguration();
    cfg.maxSessions = maxSessions;
    return cfg;
}

describe('ShellSessionManager', () => {
    let manager: ShellSessionManager;

    afterEach(async () => {
        if (manager !== undefined) {
            await manager.close();
        }
    });

    describe('job registry', () => {
        it('getJobStatus throws for an unknown job', async () => {
            manager = new ShellSessionManager(
                { create: async () => new MockExecutor() },
                createConfig(),
                createWorkspace(process.cwd())
            );
            await expect(manager.getJobStatus('nope')).rejects.toThrow('Job not found');
        });

        it('listJobs throws for an unknown session with no retained jobs', async () => {
            manager = new ShellSessionManager(
                { create: async () => new MockExecutor() },
                createConfig(),
                createWorkspace(process.cwd())
            );
            await expect(manager.listJobs('bad-id')).rejects.toThrow('Session not found');
        });

        it('evicts the oldest finished jobs beyond the cap', async () => {
            const exec = new MockExecutor();
            manager = new ShellSessionManager(
                { create: async () => exec },
                createConfig(),
                createWorkspace(process.cwd())
            );
            const id = await manager.createSession();
            const ids: string[] = [];
            for (let i = 1; i <= 210; i++) {
                ids.push((await manager.submitCommand(id, `job-${i}`)).id);
            }
            await vi.waitFor(async () =>
                expect((await manager.getJobStatus(ids[209]!)).status).toBe(ShellJobStatus.Completed)
            );
            await expect(manager.getJobStatus(ids[0]!)).rejects.toThrow('Job not found');
            await expect(manager.getJobStatus(ids[9]!)).rejects.toThrow('Job not found');
            expect((await manager.getJobStatus(ids[10]!)).status).toBe(ShellJobStatus.Completed);
            expect(await manager.listJobs(id)).toHaveLength(200);
        });
        it("lists only the requested session's retained jobs", async () => {
            manager = new ShellSessionManager(
                { create: async () => new MockExecutor() },
                createConfig(),
                createWorkspace(process.cwd())
            );
            const idA = await manager.createSession();
            const idB = await manager.createSession();
            const a1 = await manager.submitCommand(idA, 'a1');
            const b1 = await manager.submitCommand(idB, 'b1');
            await vi.waitFor(async () =>
                expect((await manager.getJobStatus(b1.id)).status).toBe(ShellJobStatus.Completed)
            );
            expect((await manager.getJobStatus(a1.id)).status).toBe(ShellJobStatus.Completed);
            const jobsA = await manager.listJobs(idA);
            expect(jobsA.map((j) => j.id)).toEqual([a1.id]);
            expect(jobsA.map((j) => j.sessionId)).toEqual([idA]);
        });

        it("lists all retained jobs across sessions, oldest first", async () => {
            manager = new ShellSessionManager(
                { create: async () => new MockExecutor() },
                createConfig(),
                createWorkspace(process.cwd())
            );
            const idA = await manager.createSession();
            const idB = await manager.createSession();
            const a1 = await manager.submitCommand(idA, 'a1');
            const b1 = await manager.submitCommand(idB, 'b1');
            await vi.waitFor(async () =>
                expect((await manager.getJobStatus(b1.id)).status).toBe(ShellJobStatus.Completed)
            );
            expect((await manager.getJobStatus(a1.id)).status).toBe(ShellJobStatus.Completed);
            expect((await manager.listAllJobs()).map((j) => j.id)).toEqual([a1.id, b1.id]);
        });

        it('lists nothing when no jobs and no sessions exist', async () => {
            manager = new ShellSessionManager(
                { create: async () => new MockExecutor() },
                createConfig(),
                createWorkspace(process.cwd())
            );
            expect(await manager.listAllJobs()).toEqual([]);
            expect(await manager.listSessions()).toEqual([]);
        });

        it('snapshots a session with a running and a queued job', async () => {
            const exec = new DeferredExecutor();
            manager = new ShellSessionManager(
                { create: async () => exec },
                createConfig(),
                createWorkspace(process.cwd())
            );
            const id = await manager.createSession();
            const running = await manager.submitCommand(id, 'block');
            await vi.waitFor(async () => expect(exec.executeCalls).toHaveLength(1));
            await manager.submitCommand(id, 'queued');
            expect(await manager.listSessions()).toEqual([
                {
                    id,
                    workspaceRoot: process.cwd(),
                    queued: 1,
                    runningJobId: running.id
                }
            ]);
            exec.complete();
        });

        it('snapshots a session with no running job', async () => {
            manager = new ShellSessionManager(
                { create: async () => new MockExecutor() },
                createConfig(),
                createWorkspace(process.cwd())
            );
            const id = await manager.createSession();
            expect(await manager.listSessions()).toEqual([
                { id, workspaceRoot: process.cwd(), queued: 0 }
            ]);
        });

        it('skips pending jobs when evicting beyond the job cap', async () => {
            const pendingExec = new DeferredExecutor();
            const fastExec = new MockExecutor();
            let created = 0;
            manager = new ShellSessionManager(
                {
                    create: async () => (created++ === 0 ? pendingExec : fastExec)
                },
                createConfig(),
                createWorkspace(process.cwd())
            );
            const pendingSession = await manager.createSession();
            const running = await manager.submitCommand(pendingSession, 'pending');
            await vi.waitFor(async () => expect(pendingExec.executeCalls).toHaveLength(1));

            const fastSession = await manager.createSession();
            const fastIds: string[] = [];
            for (let i = 0; i < 200; i++) {
                fastIds.push((await manager.submitCommand(fastSession, `fast-${i}`)).id);
            }
            await vi.waitFor(async () =>
                expect((await manager.getJobStatus(fastIds[199]!)).status).toBe(ShellJobStatus.Completed)
            );

            expect((await manager.getJobStatus(running.id)).status).toBe(ShellJobStatus.Running);
            await expect(manager.getJobStatus(fastIds[0]!)).rejects.toThrow('Job not found');
            expect((await manager.getJobStatus(fastIds[1]!)).status).toBe(ShellJobStatus.Completed);
            expect(await manager.listJobs(fastSession)).toHaveLength(199);
            pendingExec.complete();
        });
    });
});