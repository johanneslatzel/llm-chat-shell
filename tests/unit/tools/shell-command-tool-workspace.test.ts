import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Workspace, DirectoryConfiguration, AccessType } from '@johannes.latzel/llm-chat-workspace';
import { ShellCommandTool } from '../../../src/tools/shell-command-tool.js';
import { ShellSessionManager } from '../../../src/lib/session-manager.js';
import { BashShellExecutor } from '../../../src/lib/bash-executor.js';
import { PermissionSystem } from '../../../src/lib/permission.js';
import { PermissionAction, PermissionAccess } from '../../../src/lib/types.js';
import { ShellConfiguration } from '../../../src/lib/config.js';
import { ResultStatus } from '@johannes.latzel/llm-chat';
import {
    type ShellCommandResult,
    type ShellExecuteOptions,
    type ShellExecutor
} from '../../../src/lib/types.js';
import type { ShellExecutorFactory } from '../../../src/lib/session-manager.js';

function createWorkspace(cwd: string): Workspace {
    return new Workspace(
        new DirectoryConfiguration(
            [{ type: AccessType.Write, path: cwd }],
            [],
            false,
            cwd
        )
    );
}

class RecordingExecutor implements ShellExecutor {
    calls: { command: string; cwd: string | undefined; idleTimeoutMs: number | undefined }[] = [];
    async execute(command: string, options?: ShellExecuteOptions): Promise<ShellCommandResult> {
        this.calls.push({
            command,
            cwd: options?.cwd,
            idleTimeoutMs: options?.idleTimeoutMs
        });
        return { stdout: 'ok', stderr: '', exitCode: 0, timedOut: false, sessionAlive: true };
    }
    async close(): Promise<void> {}
    isAlive(): boolean {
        return true;
    }
}

describe('ShellCommandTool', () => {
    describe('useCurrentWorkspace', () => {
        it('runs in the current workspace via the job cwd and rebinds the session', async () => {
            const cfg = new ShellConfiguration();
            cfg.permissionRules = [{ pattern: '*', action: PermissionAction.Allow }];
            const ws = createWorkspace(process.cwd());
            const exec = new RecordingExecutor();
            const captureManager = new ShellSessionManager(
                { create: async () => exec },
                cfg,
                ws
            );
            const system = new PermissionSystem(cfg);
            const tool = new ShellCommandTool(captureManager, system, ws);

            const sid = await captureManager.createSession();
            const results = await tool.execute({
                command: 'echo hi',
                sessionId: sid,
                useCurrentWorkspace: true
            });
            expect(results).toHaveLength(1);
            expect(results[0]!.status).toBe(ResultStatus.Success);
            expect(exec.calls).toHaveLength(1);
            expect(exec.calls[0]!.command).toBe('echo hi');
            expect(exec.calls[0]!.cwd).toBe(process.cwd());
            expect(await captureManager.getSessionWorkspaceRoot(sid)).toBe(process.cwd());
            expect(await captureManager.getSessionCwd(sid)).toBe(process.cwd());
            await captureManager.close();
        });

        it('runs plain commands in the session cwd', async () => {
            const cfg = new ShellConfiguration();
            cfg.permissionRules = [{ pattern: '*', action: PermissionAction.Allow }];
            const ws = createWorkspace(process.cwd());
            const exec = new RecordingExecutor();
            const captureManager = new ShellSessionManager(
                { create: async () => exec },
                cfg,
                ws
            );
            const system = new PermissionSystem(cfg);
            const tool = new ShellCommandTool(captureManager, system, ws);

            const sid = await captureManager.createSession();
            const results = await tool.execute({ command: 'echo hi', sessionId: sid });
            expect(results[0]!.status).toBe(ResultStatus.Success);
            expect(exec.calls[0]!.command).toBe('echo hi');
            expect(exec.calls[0]!.cwd).toBe(process.cwd());
            await captureManager.close();
        });

        it('denies a write-rule command in a read-only-bound session and allows after rebind to a writable root', async () => {
            const readRoot = path.resolve('ws-read');
            const writeRoot = path.resolve('ws-write');
            const ws = new Workspace(
                new DirectoryConfiguration(
                    [
                        { type: AccessType.Read, path: readRoot },
                        { type: AccessType.Write, path: writeRoot }
                    ],
                    [],
                    false,
                    writeRoot
                )
            );
            const cfg = new ShellConfiguration();
            cfg.permissionRules = [
                { pattern: 'git push *', action: PermissionAction.Allow, access: PermissionAccess.Write }
            ];
            const exec = new RecordingExecutor();
            const captureManager = new ShellSessionManager(
                { create: async () => exec },
                cfg,
                ws
            );
            const system = new PermissionSystem(cfg, (root) => ws.canWrite(root));
            const tool = new ShellCommandTool(captureManager, system, ws);

            // Bound to the read-only root → write rule denied with the reason
            const sid = await captureManager.createSession(readRoot);
            let results = await tool.execute({ command: 'git push origin main', sessionId: sid });
            expect(results[0]!.status).toBe(ResultStatus.Error);
            expect(results[0]!.result).toContain('Permission denied');
            expect(results[0]!.result).toContain('requires write access');
            expect(exec.calls).toHaveLength(0);

            // Current workspace is writable → useCurrentWorkspace rebinds and allows
            results = await tool.execute({
                command: 'git push origin main',
                sessionId: sid,
                useCurrentWorkspace: true
            });
            expect(results[0]!.status).toBe(ResultStatus.Success);
            expect(await captureManager.getSessionWorkspaceRoot(sid)).toBe(writeRoot);
            expect(await captureManager.getSessionCwd(sid)).toBe(writeRoot);
            await captureManager.close();
        });

        it('checks permissions against the current workspace root', async () => {
            const rootA = path.resolve('ws-a');
            const rootB = path.resolve('ws-b');
            const ws = new Workspace(
                new DirectoryConfiguration(
                    [
                        { type: AccessType.Write, path: rootA },
                        { type: AccessType.Write, path: rootB }
                    ],
                    [],
                    false,
                    rootA
                )
            );
            const cfg = new ShellConfiguration();
            cfg.workspacePermissions.set(rootA, {
                defaultPermission: PermissionAction.Deny,
                permissionRules: [{ pattern: 'echo *', action: PermissionAction.Deny }]
            });
            cfg.workspacePermissions.set(rootB, {
                defaultPermission: PermissionAction.Allow,
                permissionRules: []
            });
            const system = new PermissionSystem(cfg);
            const exec = new RecordingExecutor();
            const captureManager = new ShellSessionManager(
                { create: async () => exec },
                cfg,
                ws
            );
            const tool = new ShellCommandTool(captureManager, system, ws);

            const sid = await captureManager.createSession(rootB);

            // Bound to rootB (allow) → allowed regardless of current workspace
            let results = await tool.execute({ command: 'echo hi', sessionId: sid });
            expect(results[0]!.status).toBe(ResultStatus.Success);

            await ws.switchWorkspace(rootA);

            // Still bound to rootB → still allowed
            results = await tool.execute({ command: 'echo hi', sessionId: sid });
            expect(results[0]!.status).toBe(ResultStatus.Success);

            // useCurrentWorkspace → checked against rootA (deny) → denied, no rebind
            results = await tool.execute({
                command: 'echo hi',
                sessionId: sid,
                useCurrentWorkspace: true
            });
            expect(results[0]!.status).toBe(ResultStatus.Error);
            expect(results[0]!.result).toContain('Permission denied');
            expect(await captureManager.getSessionWorkspaceRoot(sid)).toBe(rootB);
            expect(await captureManager.getSessionCwd(sid)).toBe(rootB);
            await captureManager.close();
        });

        it('permanently rebinds the session after a successful rebind', async () => {
            const rootA = path.resolve('ws-a');
            const rootB = path.resolve('ws-b');
            const ws = new Workspace(
                new DirectoryConfiguration(
                    [
                        { type: AccessType.Write, path: rootA },
                        { type: AccessType.Write, path: rootB }
                    ],
                    [],
                    false,
                    rootA
                )
            );
            const cfg = new ShellConfiguration();
            cfg.workspacePermissions.set(rootA, {
                defaultPermission: PermissionAction.Allow,
                permissionRules: []
            });
            cfg.workspacePermissions.set(rootB, {
                defaultPermission: PermissionAction.Deny,
                permissionRules: [{ pattern: 'echo *', action: PermissionAction.Deny }]
            });
            const system = new PermissionSystem(cfg);
            const exec = new RecordingExecutor();
            const captureManager = new ShellSessionManager(
                { create: async () => exec },
                cfg,
                ws
            );
            const tool = new ShellCommandTool(captureManager, system, ws);

            const sid = await captureManager.createSession(rootB);

            // Bound to rootB (deny) → denied
            let results = await tool.execute({ command: 'echo hi', sessionId: sid });
            expect(results[0]!.status).toBe(ResultStatus.Error);

            // useCurrentWorkspace → runs in rootA (allow), rebind to rootA
            results = await tool.execute({
                command: 'echo hi',
                sessionId: sid,
                useCurrentWorkspace: true
            });
            expect(results[0]!.status).toBe(ResultStatus.Success);
            expect(await captureManager.getSessionWorkspaceRoot(sid)).toBe(rootA);
            expect(await captureManager.getSessionCwd(sid)).toBe(rootA);

            // Now bound to rootA → allowed without the flag
            results = await tool.execute({ command: 'echo hi', sessionId: sid });
            expect(results[0]!.status).toBe(ResultStatus.Success);
            expect(exec.calls[exec.calls.length - 1]!.cwd).toBe(rootA);
            await captureManager.close();
        });

        it('actually cd\'s into the current workspace in a real bash session', async () => {
            const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-a-'));
            const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-b-'));
            try {
                const ws = new Workspace(
                    new DirectoryConfiguration(
                        [
                            { type: AccessType.Write, path: dirA },
                            { type: AccessType.Write, path: dirB }
                        ],
                        [],
                        false,
                        dirA
                    )
                );
                const cfg = new ShellConfiguration();
                cfg.permissionRules = [{ pattern: 'pwd', action: PermissionAction.Allow }];
                const system = new PermissionSystem(cfg);
                const realManager = new ShellSessionManager(
                    new (class implements ShellExecutorFactory {
                        async create(cwd?: string): Promise<ShellExecutor> {
                            return new BashShellExecutor(
                                cwd ? { ...new ShellConfiguration(), cwd } : new ShellConfiguration()
                            );
                        }
                    })(),
                    cfg,
                    ws
                );
                const tool = new ShellCommandTool(realManager, system, ws);

                const sid = await realManager.createSession(dirB);

                // Without the flag, pwd stays in the session cwd
                let results = await tool.execute({ command: 'pwd', sessionId: sid });
                expect(results[0]!.status).toBe(ResultStatus.Success);
                expect(results[0]!.result).toBe(dirB);

                await ws.switchWorkspace(dirA);

                // With the flag, pwd reports the current workspace
                results = await tool.execute({
                    command: 'pwd',
                    sessionId: sid,
                    useCurrentWorkspace: true
                });
                expect(results[0]!.status).toBe(ResultStatus.Success);
                expect(results[0]!.result).toBe(dirA);

                await realManager.close();
            } finally {
                fs.rmSync(dirA, { recursive: true, force: true });
                fs.rmSync(dirB, { recursive: true, force: true });
            }
        });
    });
});