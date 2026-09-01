import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    Workspace,
    DirectoryConfiguration,
    AccessType
} from '@johannes.latzel/llm-chat-workspace';
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
});
