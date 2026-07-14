import { describe, it, expect, afterEach, vi } from 'vitest';
import { Workspace, DirectoryConfiguration, AccessType } from '@johannes.latzel/llm-chat-workspace';
import { ResultStatus } from '@johannes.latzel/llm-chat';
import { ShellJobsTool } from '../../../src/tools/shell/shell-jobs-tool.js';
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

describe('ShellJobsTool', () => {
    let manager: ShellSessionManager;

    afterEach(async () => {
        if (manager !== undefined) {
            await manager.close();
        }
    });

    it('lists submitted jobs oldest first', async () => {
        const exec = new DeferredExecutor();
        manager = new ShellSessionManager(
            { create: async () => exec },
            new ShellConfiguration(),
            createWorkspace(process.cwd())
        );
        const tool = new ShellJobsTool(manager);
        const id = await manager.createSession();
        const j1 = await manager.submitCommand(id, 'echo one');
        const j2 = await manager.submitCommand(id, 'echo two');

        const results = await tool.execute({ sessionId: id });
        expect(results).toHaveLength(1);
        expect(results[0]!.status).toBe(ResultStatus.Success);
        expect(results[0]!.result).toContain(`2 job(s) for session ${id}:`);
        const lines = results[0]!.result.split('\n').slice(1);
        expect(lines[0]).toBe(`running\t${j1.id}\techo one`);
        expect(lines[1]).toBe(`queued\t${j2.id}\techo two`);
    });

    it('reports completed jobs with their results', async () => {
        const exec = new DeferredExecutor();
        manager = new ShellSessionManager(
            { create: async () => exec },
            new ShellConfiguration(),
            createWorkspace(process.cwd())
        );
        const tool = new ShellJobsTool(manager);
        const id = await manager.createSession();
        const job = await manager.submitCommand(id, 'echo hi');
        await vi.waitFor(async () => expect(exec.executeCalls).toBe(1));
        exec.complete({
            stdout: 'ok',
            stderr: '',
            exitCode: 0,
            timedOut: false,
            sessionAlive: true
        });
        await vi.waitFor(async () =>
            expect((await manager.getJobStatus(job.id)).status).toBe(ShellJobStatus.Completed)
        );

        const results = await tool.execute({ sessionId: id });
        expect(results[0]!.status).toBe(ResultStatus.Success);
        expect(results[0]!.result).toContain(`completed\t${job.id}\techo hi`);
    });

    it('reports a success result for a session with no jobs', async () => {
        manager = new ShellSessionManager(
            { create: async () => new DeferredExecutor() },
            new ShellConfiguration(),
            createWorkspace(process.cwd())
        );
        const tool = new ShellJobsTool(manager);
        const id = await manager.createSession();

        const results = await tool.execute({ sessionId: id });
        expect(results[0]!.status).toBe(ResultStatus.Success);
        expect(results[0]!.result).toBe(`No jobs for session ${id}.`);
    });

    it('returns an error result for an unknown session', async () => {
        manager = new ShellSessionManager(
            { create: async () => new DeferredExecutor() },
            new ShellConfiguration(),
            createWorkspace(process.cwd())
        );
        const tool = new ShellJobsTool(manager);

        const results = await tool.execute({ sessionId: 'nope' });
        expect(results[0]!.status).toBe(ResultStatus.Error);
        expect(results[0]!.result).toContain('Session not found');
    });
});
