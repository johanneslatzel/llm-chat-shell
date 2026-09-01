import { describe, it, expect, afterEach, vi } from 'vitest';
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

});