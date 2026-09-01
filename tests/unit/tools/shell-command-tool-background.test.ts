import { describe, it, expect, vi } from 'vitest';
import { Workspace, DirectoryConfiguration, AccessType } from '@johannes.latzel/llm-chat-workspace';
import { ShellCommandTool } from '../../../src/tools/shell-command-tool.js';
import { ShellSessionManager } from '../../../src/lib/session-manager.js';
import { PermissionSystem } from '../../../src/lib/permission.js';
import { PermissionAction } from '../../../src/lib/types.js';
import { ShellConfiguration } from '../../../src/lib/config.js';
import { ResultStatus } from '@johannes.latzel/llm-chat';
import {
    ShellJobStatus,
    type ShellCommandResult,
    type ShellExecuteOptions,
    type ShellExecutor
} from '../../../src/lib/types.js';

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
    describe('background & timeout', () => {
        it('submits a background job and returns a jobId immediately', async () => {
            const cfg = new ShellConfiguration();
            cfg.permissionRules = [{ pattern: '*', action: PermissionAction.Allow }];
            const ws = createWorkspace(process.cwd());
            const exec = new RecordingExecutor();
            const captureManager = new ShellSessionManager({ create: async () => exec }, cfg, ws);
            const system = new PermissionSystem(cfg);
            const tool = new ShellCommandTool(captureManager, system, ws);

            const sid = await captureManager.createSession();
            const results = await tool.execute({ command: 'echo hi', sessionId: sid, background: true });
            expect(results).toHaveLength(1);
            expect(results[0]!.status).toBe(ResultStatus.Success);
            expect(results[0]!.result).toMatch(/^Background job \S+ submitted/);
            expect(results[0]!.result).toContain('shell_job_status');

            const jobId = results[0]!.result.match(/^Background job (\S+) submitted/)?.[1]!;
            await vi.waitFor(async () =>
                expect((await captureManager.getJobStatus(jobId)).status).toBe(ShellJobStatus.Completed)
            );
            expect((await captureManager.getJobStatus(jobId)).stdout).toBe('ok');
            await captureManager.close();
        });

        it('passes an explicit timeout to the executor', async () => {
            const cfg = new ShellConfiguration();
            cfg.permissionRules = [{ pattern: '*', action: PermissionAction.Allow }];
            const ws = createWorkspace(process.cwd());
            const exec = new RecordingExecutor();
            const captureManager = new ShellSessionManager({ create: async () => exec }, cfg, ws);
            const system = new PermissionSystem(cfg);
            const tool = new ShellCommandTool(captureManager, system, ws);

            const sid = await captureManager.createSession();
            const results = await tool.execute({ command: 'echo hi', sessionId: sid, timeout: 5000 });
            expect(results[0]!.status).toBe(ResultStatus.Success);
            expect(exec.calls[0]!.idleTimeoutMs).toBe(5000);
            await captureManager.close();
        });

        it('passes an explicit timeout to a background job', async () => {
            const cfg = new ShellConfiguration();
            cfg.permissionRules = [{ pattern: '*', action: PermissionAction.Allow }];
            const ws = createWorkspace(process.cwd());
            const exec = new RecordingExecutor();
            const captureManager = new ShellSessionManager({ create: async () => exec }, cfg, ws);
            const system = new PermissionSystem(cfg);
            const tool = new ShellCommandTool(captureManager, system, ws);

            const sid = await captureManager.createSession();
            const results = await tool.execute({
                command: 'echo hi',
                sessionId: sid,
                background: true,
                timeout: 5000
            });
            expect(results[0]!.status).toBe(ResultStatus.Success);
            const jobId = results[0]!.result.match(/^Background job (\S+) submitted/)?.[1]!;
            await vi.waitFor(async () =>
                expect((await captureManager.getJobStatus(jobId)).status).toBe(ShellJobStatus.Completed)
            );
            expect(exec.calls[0]!.idleTimeoutMs).toBe(5000);
            await captureManager.close();
        });

        it('ignores a non-positive timeout', async () => {
            const cfg = new ShellConfiguration();
            cfg.permissionRules = [{ pattern: '*', action: PermissionAction.Allow }];
            const ws = createWorkspace(process.cwd());
            const exec = new RecordingExecutor();
            const captureManager = new ShellSessionManager({ create: async () => exec }, cfg, ws);
            const system = new PermissionSystem(cfg);
            const tool = new ShellCommandTool(captureManager, system, ws);

            const sid = await captureManager.createSession();
            const results = await tool.execute({ command: 'echo hi', sessionId: sid, timeout: -5 });
            expect(results[0]!.status).toBe(ResultStatus.Success);
            expect(exec.calls[0]!.idleTimeoutMs).toBe(30000);
            await captureManager.close();
        });

        it('checks permissions before submitting a background job', async () => {
            const cfg = new ShellConfiguration();
            cfg.permissionRules = [{ pattern: 'echo *', action: PermissionAction.Deny }];
            const ws = createWorkspace(process.cwd());
            const exec = new RecordingExecutor();
            const captureManager = new ShellSessionManager({ create: async () => exec }, cfg, ws);
            const system = new PermissionSystem(cfg);
            const tool = new ShellCommandTool(captureManager, system, ws);

            const sid = await captureManager.createSession();
            const results = await tool.execute({ command: 'echo hi', sessionId: sid, background: true });
            expect(results[0]!.status).toBe(ResultStatus.Error);
            expect(results[0]!.result).toContain('Permission denied');
            expect(exec.calls).toHaveLength(0);
            expect(await captureManager.listJobs(sid)).toHaveLength(0);
            await captureManager.close();
        });
    });
});