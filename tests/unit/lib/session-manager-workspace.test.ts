import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Workspace, DirectoryConfiguration, AccessType } from '@johannes.latzel/llm-chat-workspace';
import { ShellSessionManager } from '../../../src/lib/session-manager.js';
import { BashShellExecutor } from '../../../src/lib/bash-executor.js';
import { ShellConfiguration } from '../../../src/lib/config.js';
import { type ShellCommandResult, type ShellExecutor } from '../../../src/lib/types.js';
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