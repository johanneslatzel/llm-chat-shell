import { describe, it, expect, afterEach, vi } from 'vitest';
import { Workspace, DirectoryConfiguration, AccessType } from '@johannes.latzel/llm-chat-workspace';
import { ResultStatus } from '@johannes.latzel/llm-chat';
import { ShellJobStatusTool } from '../../../src/tools/shell/shell-job-status-tool.js';
import { ShellSessionManager } from '../../../src/tools/shell/session-manager.js';
import { ShellConfiguration } from '../../../src/tools/shell/config.js';
import {
    ShellJobStatus,
    type ShellCommandResult,
    type ShellExecuteOptions,
    type ShellExecutor
} from '../../../src/tools/shell/types.js';

function createWorkspace(cwd: string): Workspace {
    return new Workspace(
        new DirectoryConfiguration([{ type: AccessType.Write, path: cwd }], [], false, cwd)
    );
}

/** Executor that records calls and blocks until {@link complete} is called. */
class DeferredExecutor implements ShellExecutor {
    executeCalls = 0;
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

    async execute(_command: string, _options?: ShellExecuteOptions): Promise<ShellCommandResult> {
        this.executeCalls += 1;
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

describe('ShellJobStatusTool', () => {
    let manager: ShellSessionManager;

    afterEach(async () => {
        if (manager !== undefined) {
            await manager.close();
        }
    });

    it('formats a queued job with its queue position', async () => {
        const exec = new DeferredExecutor();
        manager = new ShellSessionManager(
            { create: async () => exec },
            new ShellConfiguration(),
            createWorkspace(process.cwd())
        );
        const tool = new ShellJobStatusTool(manager);
        const id = await manager.createSession();
        await manager.submitCommand(id, 'echo one');
        await vi.waitFor(async () => expect(exec.executeCalls).toBe(1));
        const queued = await manager.submitCommand(id, 'echo two');

        const results = await tool.execute({ jobId: queued.id });
        expect(results).toHaveLength(1);
        expect(results[0]!.status).toBe(ResultStatus.Success);
        expect(results[0]!.result).toContain(`jobId: ${queued.id}`);
        expect(results[0]!.result).toContain(`session: ${id}`);
        expect(results[0]!.result).toContain('command: echo two');
        expect(results[0]!.result).toContain(`status: ${ShellJobStatus.Queued}`);
        expect(results[0]!.result).toContain('queue position: 1');
        expect(results[0]!.result).toContain('idle timeout: 3600000ms');
    });

    it('formats a completed job with output and exit code', async () => {
        const exec = new DeferredExecutor();
        manager = new ShellSessionManager(
            { create: async () => exec },
            new ShellConfiguration(),
            createWorkspace(process.cwd())
        );
        const tool = new ShellJobStatusTool(manager);
        const id = await manager.createSession();
        const job = await manager.submitCommand(id, 'echo hi');
        await vi.waitFor(async () => expect((await manager.getJobStatus(job.id)).status).toBe('running'));
        exec.complete({
            stdout: 'out',
            stderr: 'err',
            exitCode: 3,
            timedOut: false,
            sessionAlive: true
        });
        await vi.waitFor(async () =>
            expect((await manager.getJobStatus(job.id)).status).toBe(ShellJobStatus.Completed)
        );

        const results = await tool.execute({ jobId: job.id });
        expect(results[0]!.status).toBe(ResultStatus.Success);
        expect(results[0]!.result).toContain(`status: ${ShellJobStatus.Completed}`);
        expect(results[0]!.result).toContain('stdout:\nout');
        expect(results[0]!.result).toContain('[stderr] err');
        expect(results[0]!.result).toContain('[exit code: 3]');
    });

    it('marks a timed-out completed job', async () => {
        const exec = new DeferredExecutor();
        manager = new ShellSessionManager(
            { create: async () => exec },
            new ShellConfiguration(),
            createWorkspace(process.cwd())
        );
        const tool = new ShellJobStatusTool(manager);
        const id = await manager.createSession();
        const job = await manager.submitCommand(id, 'sleep 10');
        await vi.waitFor(async () => expect((await manager.getJobStatus(job.id)).status).toBe('running'));
        exec.complete({
            stdout: '',
            stderr: '',
            exitCode: -1,
            timedOut: true,
            sessionAlive: false
        });
        await vi.waitFor(async () =>
            expect((await manager.getJobStatus(job.id)).status).toBe(ShellJobStatus.Completed)
        );

        const results = await tool.execute({ jobId: job.id });
        expect(results[0]!.result).toContain('[timed out]');
    });

    it('formats a completed job without an exit-code line for exit code 0', async () => {
        const exec = new DeferredExecutor();
        manager = new ShellSessionManager(
            { create: async () => exec },
            new ShellConfiguration(),
            createWorkspace(process.cwd())
        );
        const tool = new ShellJobStatusTool(manager);
        const id = await manager.createSession();
        const job = await manager.submitCommand(id, 'echo hi');
        await vi.waitFor(async () => expect((await manager.getJobStatus(job.id)).status).toBe('running'));
        exec.complete({
            stdout: 'out',
            stderr: '',
            exitCode: 0,
            timedOut: false,
            sessionAlive: true
        });
        await vi.waitFor(async () =>
            expect((await manager.getJobStatus(job.id)).status).toBe(ShellJobStatus.Completed)
        );

        const results = await tool.execute({ jobId: job.id });
        expect(results[0]!.status).toBe(ResultStatus.Success);
        expect(results[0]!.result).toContain(`status: ${ShellJobStatus.Completed}`);
        expect(results[0]!.result).not.toContain('[exit code:');
    });

    it('formats a failed job with its error', async () => {
        const exec = new DeferredExecutor();
        manager = new ShellSessionManager(
            { create: async () => exec },
            new ShellConfiguration(),
            createWorkspace(process.cwd())
        );
        const tool = new ShellJobStatusTool(manager);
        const id = await manager.createSession();
        await manager.submitCommand(id, 'echo one');
        await vi.waitFor(async () => expect(exec.executeCalls).toBe(1));
        const queued = await manager.submitCommand(id, 'echo two');
        await manager.closeSession(id);

        const results = await tool.execute({ jobId: queued.id });
        expect(results[0]!.status).toBe(ResultStatus.Success);
        expect(results[0]!.result).toContain(`status: ${ShellJobStatus.Failed}`);
        expect(results[0]!.result).toContain('error:');
        expect(results[0]!.result).toContain('session was closed');
    });

    it('returns an error result for an unknown jobId', async () => {
        manager = new ShellSessionManager(
            { create: async () => new DeferredExecutor() },
            new ShellConfiguration(),
            createWorkspace(process.cwd())
        );
        const tool = new ShellJobStatusTool(manager);

        const results = await tool.execute({ jobId: 'nope' });
        expect(results[0]!.status).toBe(ResultStatus.Error);
        expect(results[0]!.result).toContain('Job not found');
    });
});
