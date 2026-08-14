import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Workspace, DirectoryConfiguration, AccessType } from '@johannes.latzel/llm-chat-workspace';
import { ShellSessionManager } from '../../../src/lib/session-manager.js';
import { BashShellExecutor } from '../../../src/lib/bash-executor.js';
import { ShellConfiguration } from '../../../src/lib/config.js';
import {
    ShellJobStatus,
    type ShellCommandResult,
    type ShellExecuteOptions,
    type ShellExecutor
} from '../../../src/lib/types.js';
import type { ShellExecutorFactory } from '../../../src/lib/session-manager.js';

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

function createFactory(): ShellExecutorFactory & { created: ShellExecutor[] } {
    const created: ShellExecutor[] = [];
    return {
        created,
        create: async (cwd?: string) => {
            const exec = new BashShellExecutor(
                cwd ? { ...new ShellConfiguration(), cwd } : new ShellConfiguration()
            );
            created.push(exec);
            return exec;
        }
    };
}

function createConfig(maxSessions = 10): ShellConfiguration {
    const cfg = new ShellConfiguration();
    cfg.maxSessions = maxSessions;
    return cfg;
}

describe('ShellSessionManager', () => {
    let factory: ReturnType<typeof createFactory>;
    let manager: ShellSessionManager;

    afterEach(async () => {
        if (manager !== undefined) {
            await manager.close();
        }
    });

    it('creates a session', async () => {
        factory = createFactory();
        manager = new ShellSessionManager(factory, createConfig(), createWorkspace(process.cwd()));
        const id = await manager.createSession();
        expect(typeof id).toBe('string');
    });

    it('executes a command', async () => {
        factory = createFactory();
        manager = new ShellSessionManager(factory, createConfig(), createWorkspace(process.cwd()));
        const id = await manager.createSession();
        const result = await manager.executeCommand(id, 'echo hello');
        expect(result.stdout).toBe('hello');
    });

    it('throws on unknown session', async () => {
        factory = createFactory();
        manager = new ShellSessionManager(factory, createConfig(), createWorkspace(process.cwd()));
        await expect(manager.executeCommand('bad-id', 'echo hi')).rejects.toThrow(
            'Session not found'
        );
    });

    it('closes a session', async () => {
        factory = createFactory();
        manager = new ShellSessionManager(factory, createConfig(), createWorkspace(process.cwd()));
        const id = await manager.createSession();
        await manager.closeSession(id);
    });

    it('enforces max session limit', async () => {
        factory = createFactory();
        manager = new ShellSessionManager(factory, createConfig(2), createWorkspace(process.cwd()));
        await manager.createSession();
        await manager.createSession();
        await expect(manager.createSession()).rejects.toThrow('Maximum sessions reached');
    });

    it('allows new session after closing one', async () => {
        factory = createFactory();
        manager = new ShellSessionManager(factory, createConfig(1), createWorkspace(process.cwd()));
        const id = await manager.createSession();
        await manager.closeSession(id);
        const newId = await manager.createSession();
        expect(newId).not.toBe(id);
    });

    it('handles closeSession for non-existent session', async () => {
        factory = createFactory();
        manager = new ShellSessionManager(factory, createConfig(), createWorkspace(process.cwd()));
        await manager.closeSession('non-existent-id');
    });

    it('closes all sessions', async () => {
        factory = createFactory();
        manager = new ShellSessionManager(factory, createConfig(), createWorkspace(process.cwd()));
        await manager.createSession();
        await manager.createSession();
        await manager.close();
        expect(factory.created.length).toBe(2);
    });

    describe('background jobs', () => {
        it('submits a background job and returns immediately', async () => {
            const exec = new DeferredExecutor();
            manager = new ShellSessionManager(
                { create: async () => exec },
                createConfig(),
                createWorkspace(process.cwd())
            );
            const id = await manager.createSession();
            const job = await manager.submitCommand(id, 'echo hi');
            expect(job.id).toBeTypeOf('string');
            expect(job.sessionId).toBe(id);
            expect(job.command).toBe('echo hi');
            expect(job.status).toBe(ShellJobStatus.Running);
            await vi.waitFor(async () => expect(exec.executeCalls).toHaveLength(1));
            expect(exec.executeCalls[0]!.command).toBe('echo hi');
        });

        it('throws for an unknown session on submit', async () => {
            manager = new ShellSessionManager(
                { create: async () => new MockExecutor() },
                createConfig(),
                createWorkspace(process.cwd())
            );
            await expect(manager.submitCommand('bad-id', 'echo hi')).rejects.toThrow(
                'Session not found'
            );
        });

        it('uses backgroundTimeout when no timeout is requested', async () => {
            const cfg = createConfig();
            cfg.backgroundTimeout = 60000;
            const exec = new DeferredExecutor();
            manager = new ShellSessionManager({ create: async () => exec }, cfg, createWorkspace(process.cwd()));
            const id = await manager.createSession();
            await manager.submitCommand(id, 'echo hi');
            await vi.waitFor(async () => expect(exec.executeCalls).toHaveLength(1));
            expect(exec.executeCalls[0]!.idleTimeoutMs).toBe(60000);
        });

        it('passes an explicit timeout capped at maxTimeout', async () => {
            const cfg = createConfig();
            cfg.maxTimeout = 5000;
            const exec = new DeferredExecutor();
            manager = new ShellSessionManager({ create: async () => exec }, cfg, createWorkspace(process.cwd()));
            const id = await manager.createSession();
            await manager.submitCommand(id, 'echo hi', { timeout: 999999 });
            await vi.waitFor(async () => expect(exec.executeCalls).toHaveLength(1));
            expect(exec.executeCalls[0]!.idleTimeoutMs).toBe(5000);
        });

        it('runs background jobs one at a time in FIFO order', async () => {
            const cfg = createConfig();
            cfg.backgroundTimeout = 1000;
            const exec = new DeferredExecutor();
            manager = new ShellSessionManager({ create: async () => exec }, cfg, createWorkspace(process.cwd()));
            const id = await manager.createSession();
            const j1 = await manager.submitCommand(id, 'job1');
            const j2 = await manager.submitCommand(id, 'job2');
            const j3 = await manager.submitCommand(id, 'job3');
            await vi.waitFor(async () =>
                expect(exec.executeCalls).toEqual([{ command: 'job1', idleTimeoutMs: 1000 }])
            );
            expect((await manager.getJobStatus(j2.id)).status).toBe(ShellJobStatus.Queued);
            expect((await manager.getJobStatus(j2.id)).position).toBe(1);
            expect((await manager.getJobStatus(j3.id)).position).toBe(2);
            exec.complete();
            await vi.waitFor(async () =>
                expect(exec.executeCalls).toEqual([
                    { command: 'job1', idleTimeoutMs: 1000 },
                    { command: 'job2', idleTimeoutMs: 1000 }
                ])
            );
            exec.complete();
            await vi.waitFor(async () =>
                expect(exec.executeCalls).toEqual([
                    { command: 'job1', idleTimeoutMs: 1000 },
                    { command: 'job2', idleTimeoutMs: 1000 },
                    { command: 'job3', idleTimeoutMs: 1000 }
                ])
            );
            exec.complete();
            await vi.waitFor(async () =>
                expect((await manager.getJobStatus(j1.id)).status).toBe(ShellJobStatus.Completed)
            );
            await vi.waitFor(async () =>
                expect((await manager.getJobStatus(j3.id)).status).toBe(ShellJobStatus.Completed)
            );
        });

        it('blocks a foreground command until queued background jobs finish', async () => {
            const exec = new DeferredExecutor();
            manager = new ShellSessionManager(
                { create: async () => exec },
                createConfig(),
                createWorkspace(process.cwd())
            );
            const id = await manager.createSession();
            await manager.submitCommand(id, 'bg1');
            await vi.waitFor(async () =>
                expect(exec.executeCalls).toEqual([{ command: 'bg1', idleTimeoutMs: 3600000 }])
            );

            let settled = false;
            const fgPromise = manager.executeCommand(id, 'fg', { timeout: 5000 }).then((r) => {
                settled = true;
                return r;
            });
            await vi.waitFor(async () =>
                expect(
                    (await manager.listJobs(id)).some(
                        (j) => j.command === 'fg' && j.status === ShellJobStatus.Queued
                    )
                ).toBe(true)
            );
            expect(settled).toBe(false);

            exec.complete();
            await vi.waitFor(async () =>
                expect(exec.executeCalls).toEqual([
                    { command: 'bg1', idleTimeoutMs: 3600000 },
                    { command: 'fg', idleTimeoutMs: 5000 }
                ])
            );
            expect(settled).toBe(false);

            exec.complete({
                stdout: 'fg-out',
                stderr: '',
                exitCode: 0,
                timedOut: false,
                sessionAlive: true
            });
            const result = await fgPromise;
            expect(settled).toBe(true);
            expect(result.stdout).toBe('fg-out');
        });

        it('fails queued background jobs when the session is closed', async () => {
            const exec = new DeferredExecutor();
            manager = new ShellSessionManager(
                { create: async () => exec },
                createConfig(),
                createWorkspace(process.cwd())
            );
            const id = await manager.createSession();
            await manager.submitCommand(id, 'bg1');
            await vi.waitFor(async () => expect(exec.executeCalls).toHaveLength(1));
            const queued = await manager.submitCommand(id, 'bg2');

            await manager.closeSession(id);
            expect((await manager.getJobStatus(queued.id)).status).toBe(ShellJobStatus.Failed);
            expect((await manager.getJobStatus(queued.id)).error).toContain('session was closed');
        });

        it('throws from executeCommand when a queued job is failed by closing the session', async () => {
            const exec = new DeferredExecutor();
            manager = new ShellSessionManager(
                { create: async () => exec },
                createConfig(),
                createWorkspace(process.cwd())
            );
            const id = await manager.createSession();
            await manager.submitCommand(id, 'bg1');
            await vi.waitFor(async () => expect(exec.executeCalls).toHaveLength(1));
            const fgPromise = manager.executeCommand(id, 'fg').then(
                () => {
                    throw new Error('expected rejection');
                },
                (error: unknown) => error as Error
            );
            await vi.waitFor(async () =>
                expect(
                    (await manager.listJobs(id)).some(
                        (j) => j.command === 'fg' && j.status === ShellJobStatus.Queued
                    )
                ).toBe(true)
            );
            await manager.closeSession(id);
            const error = await fgPromise;
            expect(error.message).toContain('session was closed');
        });

        it('fails queued jobs when the session dies mid-execution', async () => {
            const exec = new DeferredExecutor();
            manager = new ShellSessionManager(
                { create: async () => exec },
                createConfig(),
                createWorkspace(process.cwd())
            );
            const id = await manager.createSession();
            const j1 = await manager.submitCommand(id, 'bg1');
            const j2 = await manager.submitCommand(id, 'bg2');
            await vi.waitFor(async () => expect(exec.executeCalls).toHaveLength(1));
            exec.complete({
                stdout: '',
                stderr: '',
                exitCode: -1,
                timedOut: true,
                sessionAlive: false
            });
            await vi.waitFor(async () =>
                expect((await manager.getJobStatus(j2.id)).status).toBe(ShellJobStatus.Failed)
            );
            expect((await manager.getJobStatus(j2.id)).error).toContain('session died');
            expect((await manager.getJobStatus(j1.id)).status).toBe(ShellJobStatus.Completed);
            expect((await manager.getJobStatus(j1.id)).timedOut).toBe(true);
        });

        it('keeps finished jobs queryable after session death', async () => {
            const exec = new DeferredExecutor();
            manager = new ShellSessionManager(
                { create: async () => exec },
                createConfig(),
                createWorkspace(process.cwd())
            );
            const id = await manager.createSession();
            const job = await manager.submitCommand(id, 'echo hi');
            await vi.waitFor(async () => expect(exec.executeCalls).toHaveLength(1));
            exec.complete({
                stdout: 'out',
                stderr: 'err',
                exitCode: 0,
                timedOut: false,
                sessionAlive: false
            });
            await vi.waitFor(async () =>
                expect((await manager.getJobStatus(job.id)).status).toBe(ShellJobStatus.Completed)
            );
            expect((await manager.getJobStatus(job.id)).stdout).toBe('out');
            await expect(manager.getSessionWorkspaceRoot(id)).rejects.toThrow('process exited');
            const jobs = await manager.listJobs(id);
            expect(jobs).toHaveLength(1);
            expect(jobs[0]!.id).toBe(job.id);
        });
        it('fails a background job when the command execution throws', async () => {
            const failing: ShellExecutor = {
                async execute(_command: string): Promise<ShellCommandResult> {
                    throw new Error('exec boom');
                },
                async close(): Promise<void> {},
                isAlive(): boolean {
                    return true;
                }
            };
            manager = new ShellSessionManager(
                { create: async () => failing },
                createConfig(),
                createWorkspace(process.cwd())
            );
            const id = await manager.createSession();
            const job = await manager.submitCommand(id, 'echo hi');
            await vi.waitFor(async () =>
                expect((await manager.getJobStatus(job.id)).status).toBe(ShellJobStatus.Failed)
            );
            expect((await manager.getJobStatus(job.id)).error).toBe('exec boom');
        });

        it('fails a background job when an unexpected error escapes the runner', async () => {
            const exploding: ShellExecutor = {
                async execute(_command: string): Promise<ShellCommandResult> {
                    return {
                        stdout: '',
                        stderr: '',
                        exitCode: -1,
                        timedOut: true,
                        sessionAlive: false
                    };
                },
                close(): never {
                    throw new Error('close boom');
                },
                isAlive(): boolean {
                    return true;
                }
            };
            manager = new ShellSessionManager(
                { create: async () => exploding },
                createConfig(),
                createWorkspace(process.cwd())
            );
            const id = await manager.createSession();
            const job = await manager.submitCommand(id, 'echo hi');
            await vi.waitFor(async () =>
                expect((await manager.getJobStatus(job.id)).status).toBe(ShellJobStatus.Failed)
            );
            expect((await manager.getJobStatus(job.id)).error).toBe('unexpected failure: close boom');
        });

        it('skips the last-used bump when the session disappears mid-run', async () => {
            const exec = new DeferredExecutor();
            manager = new ShellSessionManager(
                { create: async () => exec },
                createConfig(),
                createWorkspace(process.cwd())
            );
            const id = await manager.createSession();
            const job = await manager.submitCommand(id, 'echo hi');
            await vi.waitFor(async () => expect(exec.executeCalls).toHaveLength(1));
            await manager.closeSession(id);
            exec.complete({
                stdout: 'done',
                stderr: '',
                exitCode: 0,
                timedOut: false,
                sessionAlive: true
            });
            await vi.waitFor(async () =>
                expect((await manager.getJobStatus(job.id)).status).toBe(ShellJobStatus.Completed)
            );
            expect((await manager.getJobStatus(job.id)).stdout).toBe('done');
            await expect(manager.getSessionWorkspaceRoot(id)).rejects.toThrow('was closed');
        });

        it("keeps the stored position when a queued job's session disappears", async () => {
            const exec = new DeferredExecutor();
            manager = new ShellSessionManager(
                { create: async () => exec },
                createConfig(),
                createWorkspace(process.cwd())
            );
            const id = await manager.createSession();
            await manager.submitCommand(id, 'bg1');
            const queued = await manager.submitCommand(id, 'bg2');
            await vi.waitFor(async () => expect(exec.executeCalls).toHaveLength(1));
            expect((await manager.getJobStatus(queued.id)).position).toBe(1);
            (manager as unknown as { sessions: { remove: (sessionId: string) => unknown } }).sessions.remove(id);
            expect((await manager.getJobStatus(queued.id)).status).toBe(ShellJobStatus.Queued);
            expect((await manager.getJobStatus(queued.id)).position).toBe(1);
            exec.complete();
        });
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

    describe('session death & expiry', () => {
        it('prunes a dead session on create so cap slots are freed', async () => {

            const cfg = createConfig(1);
            const dead = new MockExecutor(undefined, false);
            const live = new MockExecutor();
            const execs = [dead, live];
            let index = 0;
            manager = new ShellSessionManager(
                { create: async () => execs[index++]! },
                cfg,
                createWorkspace(process.cwd())
            );
            await manager.createSession();
            const id = await manager.createSession();
            expect(await manager.getSessionWorkspaceRoot(id)).toBe(process.cwd());
        });

        it('removes and tombstones a session whose process died during execution', async () => {
            const cfg = createConfig();
            const dead = new MockExecutor(
                { stdout: '', stderr: '', exitCode: 137, timedOut: false, sessionAlive: false },
                false
            );
            manager = new ShellSessionManager(
                { create: async () => dead },
                cfg,
                createWorkspace(process.cwd())
            );
            const id = await manager.createSession();
            const result = await manager.executeCommand(id, 'echo hi');
            expect(result.sessionAlive).toBe(false);
            await expect(manager.getSessionWorkspaceRoot(id)).rejects.toThrow(
                'underlying shell process exited'
            );
        });

        it('removes a session whose process died even when the result claims it is alive', async () => {
            const cfg = createConfig();
            const dead = new MockExecutor(undefined, false);
            manager = new ShellSessionManager(
                { create: async () => dead },
                cfg,
                createWorkspace(process.cwd())
            );
            const id = await manager.createSession();
            const result = await manager.executeCommand(id, 'true');
            expect(result.exitCode).toBe(0);
            await expect(manager.getSessionWorkspaceRoot(id)).rejects.toThrow(
                'underlying shell process exited'
            );
        });

        it('tombstones a timed-out session with the configured idle limit', async () => {
            const cfg = createConfig();
            cfg.ctrlCTimeout = 4242;
            const timedOut = new MockExecutor(
                { stdout: '', stderr: '', exitCode: -1, timedOut: true, sessionAlive: false },
                false
            );
            manager = new ShellSessionManager(
                { create: async () => timedOut },
                cfg,
                createWorkspace(process.cwd())
            );
            const id = await manager.createSession();
            await manager.executeCommand(id, 'sleep 10');
            await expect(manager.getSessionWorkspaceRoot(id)).rejects.toThrow('idle limit: 4242ms');
            await expect(manager.executeCommand(id, 'echo again')).rejects.toThrow(
                'idle limit: 4242ms'
            );
        });

        it('returns a descriptive error for a closed session', async () => {
            const cfg = createConfig();
            manager = new ShellSessionManager(
                { create: async () => new MockExecutor() },
                cfg,
                createWorkspace(process.cwd())
            );
            const id = await manager.createSession();
            await manager.closeSession(id);
            await expect(manager.getSessionWorkspaceRoot(id)).rejects.toThrow('was closed');
        });

        it('evicts the oldest tombstones beyond the cap (FIFO)', async () => {
            const cfg = createConfig(150);
            manager = new ShellSessionManager(
                { create: async () => new MockExecutor() },
                cfg,
                createWorkspace(process.cwd())
            );
            const ids: string[] = [];
            for (let i = 0; i < 120; i++) {
                ids.push(await manager.createSession());
            }
            for (const id of ids) {
                await manager.closeSession(id);
            }
            await expect(manager.getSessionWorkspaceRoot(ids[0]!)).rejects.toThrow('Session not found');
            await expect(manager.getSessionWorkspaceRoot(ids[119]!)).rejects.toThrow('was closed');
        });

        it('expires idle sessions via the sweeper', async () => {
            vi.useFakeTimers();
            try {
                const cfg = createConfig();
                cfg.sessionTimeout = 1000;
                manager = new ShellSessionManager(
                    { create: async () => new MockExecutor() },
                    cfg,
                    createWorkspace(process.cwd())
                );
                const id = await manager.createSession();
                await vi.advanceTimersByTimeAsync(1500);
                await expect(manager.getSessionWorkspaceRoot(id)).rejects.toThrow(
                    'expired after being idle for too long'
                );
            } finally {
                vi.useRealTimers();
            }
        });

        it('does not expire a session that was used before the sweeper tick', async () => {
            vi.useFakeTimers();
            try {
                const cfg = createConfig();
                cfg.sessionTimeout = 1000;
                manager = new ShellSessionManager(
                    { create: async () => new MockExecutor() },
                    cfg,
                    createWorkspace(process.cwd())
                );
                const id = await manager.createSession();
                await vi.advanceTimersByTimeAsync(500);
                await manager.executeCommand(id, 'echo hi');
                await vi.advanceTimersByTimeAsync(1200);
                await expect(manager.getSessionWorkspaceRoot(id)).resolves.not.toThrow();
            } finally {
                vi.useRealTimers();
            }
        });

        it('is idempotent when closed multiple times', async () => {
            vi.useFakeTimers();
            try {
                const cfg = createConfig();
                cfg.sessionTimeout = 1000;
                manager = new ShellSessionManager(
                    { create: async () => new MockExecutor() },
                    cfg,
                    createWorkspace(process.cwd())
                );
                await manager.createSession();
                await manager.close();
                await manager.close();
                await vi.advanceTimersByTimeAsync(5000);
            } finally {
                vi.useRealTimers();
            }
        });

        it('does not start a sweeper when sessionTimeout is not positive', async () => {
            vi.useFakeTimers();
            try {
                const cfg = createConfig();
                cfg.sessionTimeout = 0;
                manager = new ShellSessionManager(
                    { create: async () => new MockExecutor() },
                    cfg,
                    createWorkspace(process.cwd())
                );
                const id = await manager.createSession();
                await vi.advanceTimersByTimeAsync(5000);
                await expect(manager.getSessionWorkspaceRoot(id)).resolves.not.toThrow();
            } finally {
                vi.useRealTimers();
            }
        });

        it('skips expiry when sessionTimeout becomes non-positive after the sweeper started', async () => {
            vi.useFakeTimers();
            try {
                const cfg = createConfig();
                cfg.sessionTimeout = 1000;
                manager = new ShellSessionManager(
                    { create: async () => new MockExecutor() },
                    cfg,
                    createWorkspace(process.cwd())
                );
                const id = await manager.createSession();
                cfg.sessionTimeout = 0;
                await vi.advanceTimersByTimeAsync(1500);
                await expect(manager.getSessionWorkspaceRoot(id)).resolves.not.toThrow();
            } finally {
                vi.useRealTimers();
            }
        });

        it('skips expiry when sessionTimeout is not finite', async () => {
            vi.useFakeTimers();
            try {
                const cfg = createConfig();
                cfg.sessionTimeout = 1000;
                manager = new ShellSessionManager(
                    { create: async () => new MockExecutor() },
                    cfg,
                    createWorkspace(process.cwd())
                );
                const id = await manager.createSession();
                cfg.sessionTimeout = Number.NaN;
                await vi.advanceTimersByTimeAsync(1500);
                await expect(manager.getSessionWorkspaceRoot(id)).resolves.not.toThrow();
            } finally {
                vi.useRealTimers();
            }
        });

        it('tolerates close failures during idle expiry', async () => {
            vi.useFakeTimers();
            try {
                const cfg = createConfig();
                cfg.sessionTimeout = 1000;
                manager = new ShellSessionManager(
                    { create: async () => new MockExecutor(undefined, true, true) },
                    cfg,
                    createWorkspace(process.cwd())
                );
                const id = await manager.createSession();
                await vi.advanceTimersByTimeAsync(1500);
                await expect(manager.getSessionWorkspaceRoot(id)).rejects.toThrow(
                    'expired after being idle for too long'
                );
            } finally {
                vi.useRealTimers();
            }
        });

        it('tolerates close failures after a timeout-killed session', async () => {
            const cfg = createConfig();
            const timedOut = new MockExecutor(
                { stdout: '', stderr: '', exitCode: -1, timedOut: true, sessionAlive: false },
                false,
                true
            );
            manager = new ShellSessionManager(
                { create: async () => timedOut },
                cfg,
                createWorkspace(process.cwd())
            );
            const id = await manager.createSession();
            const result = await manager.executeCommand(id, 'sleep 10');
            expect(result.timedOut).toBe(true);
            await expect(manager.getSessionWorkspaceRoot(id)).rejects.toThrow('idle limit');
        });

        it('does not double-remove a session that was closed mid-execution', async () => {
            const cfg = createConfig();
            const timedOut = new MockExecutor(
                { stdout: '', stderr: '', exitCode: -1, timedOut: true, sessionAlive: false },
                false
            );
            let id = '';
            const removingExecutor: ShellExecutor = {
                async execute(_command: string): Promise<ShellCommandResult> {
                    await manager.closeSession(id);
                    return timedOut.execute(_command);
                },
                close: () => timedOut.close(),
                isAlive: () => timedOut.isAlive()
            };
            manager = new ShellSessionManager(
                { create: async () => removingExecutor },
                cfg,
                createWorkspace(process.cwd())
            );
            id = await manager.createSession();
            const result = await manager.executeCommand(id, 'sleep 10');
            expect(result.timedOut).toBe(true);
            await expect(manager.getSessionWorkspaceRoot(id)).rejects.toThrow('was closed');
        });

        it('keeps the closed tombstone when the shell dies after closeSession', async () => {
            const exec = new DeferredExecutor();
            manager = new ShellSessionManager(
                { create: async () => exec },
                createConfig(),
                createWorkspace(process.cwd())
            );
            const id = await manager.createSession();
            const job = await manager.submitCommand(id, 'ghost');
            await vi.waitFor(async () => expect(exec.executeCalls).toHaveLength(1));

            await manager.closeSession(id);
            exec.complete({
                stdout: '',
                stderr: '',
                exitCode: 137,
                timedOut: false,
                sessionAlive: false
            });
            await vi.waitFor(async () =>
                expect((await manager.getJobStatus(job.id)).status).toBe(ShellJobStatus.Completed)
            );
            await expect(manager.getSessionWorkspaceRoot(id)).rejects.toThrow('was closed');
        });

        it('does not double-close an executor closed mid-run by the manager', async () => {
            let closeCalls = 0;
            let resolveExecute: ((result: ShellCommandResult) => void) | undefined;
            const exec: ShellExecutor = {
                execute(): Promise<ShellCommandResult> {
                    return new Promise((resolve) => {
                        resolveExecute = resolve;
                    });
                },
                async close(): Promise<void> {
                    closeCalls++;
                },
                isAlive(): boolean {
                    return true;
                }
            };
            manager = new ShellSessionManager(
                { create: async () => exec },
                createConfig(),
                createWorkspace(process.cwd())
            );
            const id = await manager.createSession();
            const job = await manager.submitCommand(id, 'ghost');
            await vi.waitFor(() => expect(resolveExecute).toBeDefined());

            await manager.closeSession(id);
            expect(closeCalls).toBe(1);

            resolveExecute!({
                stdout: '',
                stderr: '',
                exitCode: 137,
                timedOut: false,
                sessionAlive: false
            });
            await vi.waitFor(async () =>
                expect((await manager.getJobStatus(job.id)).status).toBe(ShellJobStatus.Completed)
            );
            expect(closeCalls).toBe(1);
        });

        it('finishes the in-flight job and fails queued jobs on close', async () => {
            let closeCalls = 0;
            let resolveExecute: ((result: ShellCommandResult) => void) | undefined;
            const exec: ShellExecutor = {
                execute(): Promise<ShellCommandResult> {
                    return new Promise((resolve) => {
                        resolveExecute = resolve;
                    });
                },
                async close(): Promise<void> {
                    closeCalls++;
                },
                isAlive(): boolean {
                    return true;
                }
            };
            manager = new ShellSessionManager(
                { create: async () => exec },
                createConfig(),
                createWorkspace(process.cwd())
            );
            const id = await manager.createSession();
            const running = await manager.submitCommand(id, 'running');
            const queued = await manager.submitCommand(id, 'queued');
            await vi.waitFor(() => expect(resolveExecute).toBeDefined());

            await manager.close();
            expect((await manager.getJobStatus(queued.id)).status).toBe(ShellJobStatus.Failed);
            expect((await manager.getJobStatus(queued.id)).error).toContain('was disposed');

            resolveExecute!({
                stdout: 'out',
                stderr: '',
                exitCode: 0,
                timedOut: false,
                sessionAlive: true
            });
            await vi.waitFor(async () =>
                expect((await manager.getJobStatus(running.id)).status).toBe(ShellJobStatus.Completed)
            );
            expect((await manager.getJobStatus(running.id)).stdout).toBe('out');
            expect(closeCalls).toBe(1);
        });

        it('enforces maxSessions under concurrent creates', async () => {
            let resolveCreate: (() => void) | undefined;
            let inFlight = 0;
            let maxInFlight = 0;
            manager = new ShellSessionManager(
                {
                    create: async () => {
                        inFlight++;
                        maxInFlight = Math.max(maxInFlight, inFlight);
                        await new Promise<void>((resolve) => {
                            resolveCreate = resolve;
                        });
                        inFlight--;
                        return new MockExecutor();
                    }
                },
                createConfig(1),
                createWorkspace(process.cwd())
            );
            const p1 = manager.createSession();
            const p2 = manager.createSession();
            await vi.waitFor(() => expect(resolveCreate).toBeDefined());
            resolveCreate!();
            const settled = await Promise.allSettled([p1, p2]);
            const fulfilled = settled.filter(
                (r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled'
            );
            const rejected = settled.filter(
                (r): r is PromiseRejectedResult => r.status === 'rejected'
            );
            expect(fulfilled).toHaveLength(1);
            expect(rejected).toHaveLength(1);
            expect((rejected[0]!.reason as Error).message).toContain('Maximum sessions reached');
            expect(maxInFlight).toBe(1);
        });
    });

    describe('workspace binding', () => {
        it('binds a session to the workspace root of its cwd', async () => {
            const cfg = createConfig();
            const workspace = createWorkspace(process.cwd());
            manager = new ShellSessionManager(
                { create: async () => new MockExecutor() },
                cfg,
                workspace
            );
            const id = await manager.createSession('.');
            expect(await manager.getSessionWorkspaceRoot(id)).toBe(process.cwd());
        });

        it('binds a session to the current workspace path when no cwd is provided', async () => {
            const cfg = createConfig();
            const workspace = createWorkspace(process.cwd());
            manager = new ShellSessionManager(
                { create: async () => new MockExecutor() },
                cfg,
                workspace
            );
            const id = await manager.createSession();
            expect(await manager.getSessionWorkspaceRoot(id)).toBe(process.cwd());
        });

        it('binds to the deepest containing access root', async () => {
            const cfg = createConfig();
            const root = path.resolve('root-a');
            const nested = path.resolve('root-a/nested');
            const workspace = new Workspace(
                new DirectoryConfiguration(
                    [
                        { type: AccessType.Write, path: root },
                        { type: AccessType.Write, path: nested }
                    ],
                    [],
                    false,
                    root
                )
            );
            manager = new ShellSessionManager(
                { create: async () => new MockExecutor() },
                cfg,
                workspace
            );
            const id = await manager.createSession(nested);
            expect(await manager.getSessionWorkspaceRoot(id)).toBe(nested);
        });

        it('rebindSession permanently changes the bound root and cwd', async () => {
            const cfg = createConfig();
            const workspace = createWorkspace(process.cwd());
            manager = new ShellSessionManager(
                { create: async () => new MockExecutor() },
                cfg,
                workspace
            );
            const id = await manager.createSession();
            await manager.rebindSession(id, '/other-root', '/other-cwd');
            expect(await manager.getSessionWorkspaceRoot(id)).toBe('/other-root');
            expect(await manager.getSessionCwd(id)).toBe('/other-cwd');
        });

        it('throws for unknown session in getSessionWorkspaceRoot', async () => {
            const cfg = createConfig();
            manager = new ShellSessionManager(
                { create: async () => new MockExecutor() },
                cfg,
                createWorkspace(process.cwd())
            );
            await expect(manager.getSessionWorkspaceRoot('bad-id')).rejects.toThrow('Session not found');
        });

        it('throws for unknown session in getSessionCwd', async () => {
            const cfg = createConfig();
            manager = new ShellSessionManager(
                { create: async () => new MockExecutor() },
                cfg,
                createWorkspace(process.cwd())
            );
            await expect(manager.getSessionCwd('bad-id')).rejects.toThrow('Session not found');
        });

        it('throws for unknown session in rebindSession', async () => {
            const cfg = createConfig();
            manager = new ShellSessionManager(
                { create: async () => new MockExecutor() },
                cfg,
                createWorkspace(process.cwd())
            );
            await expect(manager.rebindSession('bad-id', '/x', '/y')).rejects.toThrow(
                'Session not found'
            );
        });
    });

    describe('cwd validation', () => {
        it('creates session with valid relative cwd', async () => {
            const cfg = createConfig();
            factory = createFactory();
            manager = new ShellSessionManager(factory, cfg, createWorkspace(process.cwd()));
            const id = await manager.createSession('.');
            expect(typeof id).toBe('string');
        });

        it('creates session with valid absolute cwd within the workspace', async () => {
            const cfg = createConfig();
            factory = createFactory();
            manager = new ShellSessionManager(factory, cfg, createWorkspace(process.cwd()));
            const id = await manager.createSession(process.cwd());
            expect(typeof id).toBe('string');
        });

        it('rejects path traversal', async () => {
            const cfg = createConfig();
            factory = createFactory();
            manager = new ShellSessionManager(factory, cfg, createWorkspace(process.cwd()));
            await expect(manager.createSession('../../etc/passwd')).rejects.toThrow(
                'cwd must be within the configured working directory'
            );
        });

        it('rejects absolute path outside the workspace', async () => {
            const cfg = createConfig();
            factory = createFactory();
            manager = new ShellSessionManager(factory, cfg, createWorkspace(process.cwd()));
            await expect(manager.createSession('/tmp')).rejects.toThrow(
                'cwd must be within the configured working directory'
            );
        });

        it('passes resolved cwd to factory', async () => {
            const cfg = createConfig();
            const receivedCwds: (string | undefined)[] = [];
            const trackingFactory: ShellExecutorFactory = {
                create: async (cwd?: string) => {
                    receivedCwds.push(cwd);
                    return new BashShellExecutor(cfg);
                }
            };
            manager = new ShellSessionManager(trackingFactory, cfg, createWorkspace(process.cwd()));
            await manager.createSession('src');
            expect(receivedCwds).toHaveLength(1);
            expect(receivedCwds[0]).toBe(path.resolve(process.cwd(), 'src'));
        });

        it('passes current workspace path to factory when no cwd provided', async () => {
            const cfg = createConfig();
            const receivedCwds: (string | undefined)[] = [];
            const trackingFactory: ShellExecutorFactory = {
                create: async (cwd?: string) => {
                    receivedCwds.push(cwd);
                    return new BashShellExecutor(cfg);
                }
            };
            manager = new ShellSessionManager(trackingFactory, cfg, createWorkspace(process.cwd()));
            await manager.createSession();
            expect(receivedCwds).toHaveLength(1);
            expect(receivedCwds[0]).toBe(process.cwd());
        });

        it('resolves symlinks when resolveSymlinks is true', async () => {
            const tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'shell-test-'));
            const symlinkPath = path.join(tmpDir, 'link');
            const targetPath = path.join(tmpDir, 'target');
            fs.mkdirSync(targetPath);
            fs.symlinkSync(targetPath, symlinkPath);

            const cfg = createConfig();
            const receivedCwds: (string | undefined)[] = [];
            const trackingFactory: ShellExecutorFactory = {
                create: async (cwd?: string) => {
                    receivedCwds.push(cwd);
                    return new BashShellExecutor(cfg);
                }
            };
            manager = new ShellSessionManager(trackingFactory, cfg, createWorkspace(tmpDir, true));
            await manager.createSession('link');
            expect(receivedCwds[0]).toBe(targetPath);

            fs.rmSync(tmpDir, { recursive: true });
        });

        it('does not resolve symlinks when resolveSymlinks is false', async () => {
            const tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'shell-test-'));
            const symlinkPath = path.join(tmpDir, 'link');
            const targetPath = path.join(tmpDir, 'target');
            fs.mkdirSync(targetPath);
            fs.symlinkSync(targetPath, symlinkPath);

            const cfg = createConfig();
            const receivedCwds: (string | undefined)[] = [];
            const trackingFactory: ShellExecutorFactory = {
                create: async (cwd?: string) => {
                    receivedCwds.push(cwd);
                    return new BashShellExecutor(cfg);
                }
            };
            manager = new ShellSessionManager(trackingFactory, cfg, createWorkspace(tmpDir));
            await manager.createSession('link');
            expect(receivedCwds[0]).toBe(symlinkPath);

            fs.rmSync(tmpDir, { recursive: true });
        });

        it('rejects symlink pointing outside cwd when resolveSymlinks is true', async () => {
            const tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'shell-test-'));
            const symlinkPath = path.join(tmpDir, 'escape');
            fs.symlinkSync('/tmp', symlinkPath);

            const cfg = createConfig();
            factory = createFactory();
            manager = new ShellSessionManager(factory, cfg, createWorkspace(tmpDir, true));
            await expect(manager.createSession('escape')).rejects.toThrow(
                'cwd must be within the configured working directory'
            );

            fs.rmSync(tmpDir, { recursive: true });
        });
    });
});
