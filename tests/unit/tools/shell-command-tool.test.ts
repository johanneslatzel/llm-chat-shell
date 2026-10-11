import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Workspace, DirectoryConfiguration, AccessType } from '@johannes.latzel/llm-chat-workspace';
import { ShellCommandTool } from '../../../src/tools/shell-command-tool.js';
import { ShellSessionManager } from '../../../src/lib/session-manager.js';
import { BashShellExecutor } from '../../../src/lib/bash-executor.js';
import { PermissionSystem } from '../../../src/lib/permission.js';
import { PermissionAction } from '../../../src/lib/types.js';
import { ShellConfiguration } from '../../../src/lib/config.js';
import { ResultStatus } from '@johannes.latzel/llm-chat';
import { type ShellCommandResult, type ShellExecutor } from '../../../src/lib/types.js';
import type { ShellExecutorFactory } from '../../../src/lib/session-manager.js';

function createPermissionConfig(
    rules: { pattern: string; action: PermissionAction }[]
): ShellConfiguration {
    const cfg = new ShellConfiguration();
    cfg.permissionRules = rules;
    return cfg;
}

function createWorkspace(cwd: string): Workspace {
    return new Workspace(
        new DirectoryConfiguration([{ type: AccessType.Write, path: cwd }], [], false, cwd)
    );
}

class MockExecutor implements ShellExecutor {
    constructor(private result: ShellCommandResult) {}
    async execute(_command: string): Promise<ShellCommandResult> {
        return this.result;
    }
    async close(): Promise<void> {}
    isAlive(): boolean {
        return true;
    }
}

describe('ShellCommandTool', () => {
    let created: ShellExecutor[];
    let manager: ShellSessionManager;
    let workspace: Workspace;
    let sessionId: string;

    beforeEach(async () => {
        created = [];
        const cfg = new ShellConfiguration();
        workspace = createWorkspace(process.cwd());
        const factory: ShellExecutorFactory = {
            create: async () => {
                const exec = new BashShellExecutor(new ShellConfiguration());
                created.push(exec);
                return exec;
            }
        };
        manager = new ShellSessionManager(factory, cfg, workspace);
        sessionId = await manager.createSession();
    });

    afterEach(async () => {
        for (const exec of created) {
            await exec.close();
        }
    });

    it('has correct name', () => {
        const system = new PermissionSystem(
            createPermissionConfig([{ pattern: '*', action: PermissionAction.Allow }])
        );
        const tool = new ShellCommandTool(manager, system, workspace);
        expect(tool.name).toBe('shell_command');
    });

    it('executes an allowed command', async () => {
        const system = new PermissionSystem(
            createPermissionConfig([{ pattern: 'echo *', action: PermissionAction.Allow }])
        );
        const tool = new ShellCommandTool(manager, system, workspace);

        const results = await tool.execute({ command: 'echo hello', sessionId });
        expect(results).toHaveLength(1);
        expect(results[0]!.status).toBe(ResultStatus.Success);
        expect(results[0]!.result).toBe('hello');
    });

    it('denies a forbidden command', async () => {
        const system = new PermissionSystem(
            createPermissionConfig([{ pattern: 'rm *', action: PermissionAction.Deny }])
        );
        const tool = new ShellCommandTool(manager, system, workspace);

        const results = await tool.execute({ command: 'rm -rf /tmp', sessionId });
        expect(results).toHaveLength(1);
        expect(results[0]!.status).toBe(ResultStatus.Error);
        expect(results[0]!.result).toContain('Permission denied');
    });

    it('denies a command with denied subcommand in composition', async () => {
        const system = new PermissionSystem(
            createPermissionConfig([
                { pattern: 'echo *', action: PermissionAction.Allow },
                { pattern: 'rm *', action: PermissionAction.Deny }
            ])
        );
        const tool = new ShellCommandTool(manager, system, workspace);

        const results = await tool.execute({
            command: 'echo hi && rm -rf /tmp',
            sessionId
        });
        expect(results).toHaveLength(1);
        expect(results[0]!.status).toBe(ResultStatus.Error);
    });

    it('returns error for invalid session ID', async () => {
        const system = new PermissionSystem(
            createPermissionConfig([{ pattern: '*', action: PermissionAction.Allow }])
        );
        const tool = new ShellCommandTool(manager, system, workspace);

        const results = await tool.execute({ command: 'echo hi', sessionId: 'bad-id' });
        expect(results).toHaveLength(1);
        expect(results[0]!.status).toBe(ResultStatus.Error);
    });

    it('handles non-zero exit code', async () => {
        const system = new PermissionSystem(
            createPermissionConfig([{ pattern: 'exit *', action: PermissionAction.Allow }])
        );
        const tool = new ShellCommandTool(manager, system, workspace);

        const results = await tool.execute({ command: 'exit 1', sessionId });
        expect(results).toHaveLength(1);
        expect(results[0]!.status).toBe(ResultStatus.Error);
        expect(results[0]!.result).toContain('exit code: 1');
    });

    it('formats stdout-only output', async () => {
        const system = new PermissionSystem(
            createPermissionConfig([{ pattern: 'echo *', action: PermissionAction.Allow }])
        );
        const tool = new ShellCommandTool(manager, system, workspace);

        const results = await tool.execute({ command: 'echo hello', sessionId });
        expect(results).toHaveLength(1);
        expect(results[0]!.result).toBe('hello');
        expect(results[0]!.result).not.toContain('[stderr]');
    });

    it('returns "(no output)" when command produces no output', async () => {
        const system = new PermissionSystem(
            createPermissionConfig([{ pattern: 'true', action: PermissionAction.Allow }])
        );
        const tool = new ShellCommandTool(manager, system, workspace);

        const results = await tool.execute({ command: 'true', sessionId });
        expect(results).toHaveLength(1);
        expect(results[0]!.result).toBe('(no output)');
    });

    it('returns generic "Permission denied" when command is empty', async () => {
        const system = new PermissionSystem(
            createPermissionConfig([{ pattern: 'echo *', action: PermissionAction.Allow }])
        );
        const tool = new ShellCommandTool(manager, system, workspace);

        const results = await tool.execute({ command: '', sessionId });
        expect(results).toHaveLength(1);
        expect(results[0]!.status).toBe(ResultStatus.Error);
        expect(results[0]!.result).toBe('Permission denied');
    });

    it('formats stderr in output', async () => {
        const cfg = new ShellConfiguration();
        const ws = createWorkspace(process.cwd());
        const mockManager = new ShellSessionManager(
            {
                create: async () =>
                    new MockExecutor({
                        stdout: '',
                        stderr: 'some error',
                        exitCode: 0,
                        timedOut: false,
                        sessionAlive: true
                    })
            },
            cfg,
            ws
        );
        const system = new PermissionSystem(
            createPermissionConfig([{ pattern: 'echo *', action: PermissionAction.Allow }])
        );
        const tool = new ShellCommandTool(mockManager, system, ws);

        const mockSession = await mockManager.createSession();
        const results = await tool.execute({ command: 'echo err >&2', sessionId: mockSession });
        expect(results).toHaveLength(1);
        expect(results[0]!.result).toContain('[stderr]');
        expect(results[0]!.result).toContain('some error');
        await mockManager.close();
    });

    it('formats timeout message when command times out', async () => {
        const cfg = new ShellConfiguration();
        cfg.ctrlCTimeout = 500;
        const ws = createWorkspace(process.cwd());
        const mockManager = new ShellSessionManager(
            {
                create: async () =>
                    new MockExecutor({
                        stdout: '',
                        stderr: '',
                        exitCode: -1,
                        timedOut: true,
                        sessionAlive: false,
                        idleTimeoutMs: 500
                    })
            },
            cfg,
            ws
        );
        const system = new PermissionSystem(
            createPermissionConfig([{ pattern: 'sleep *', action: PermissionAction.Allow }])
        );
        const tool = new ShellCommandTool(mockManager, system, ws);

        const mockSession = await mockManager.createSession();
        const results = await tool.execute({ command: 'sleep 10', sessionId: mockSession });
        expect(results).toHaveLength(1);
        expect(results[0]!.status).toBe(ResultStatus.Error);
        expect(results[0]!.result).toContain(
            'Command timed out and session was killed (idle limit: 500ms).'
        );
        expect(results[0]!.result).toContain('Session is no longer alive.');
        await mockManager.close();
    });

    it('formats timeout-only message when session is still alive', async () => {
        const cfg = new ShellConfiguration();
        cfg.ctrlCTimeout = 500;
        const ws = createWorkspace(process.cwd());
        const mockManager = new ShellSessionManager(
            {
                create: async () =>
                    new MockExecutor({
                        stdout: 'partial output',
                        stderr: '',
                        exitCode: -1,
                        timedOut: true,
                        sessionAlive: true
                    })
            },
            cfg,
            ws
        );
        const system = new PermissionSystem(
            createPermissionConfig([{ pattern: 'sleep *', action: PermissionAction.Allow }])
        );
        const tool = new ShellCommandTool(mockManager, system, ws);

        const mockSession = await mockManager.createSession();
        const results = await tool.execute({ command: 'sleep 10', sessionId: mockSession });
        expect(results).toHaveLength(1);
        expect(results[0]!.status).toBe(ResultStatus.Error);
        expect(results[0]!.result).toContain('Command timed out (idle limit: 500ms).');
        expect(results[0]!.result).not.toContain('Session is no longer alive.');
        expect(results[0]!.result).toContain('partial output');
        await mockManager.close();
    });

    it('reports the raw command when a redirect target is denied', async () => {
        const system = new PermissionSystem(
            createPermissionConfig([{ pattern: 'echo *', action: PermissionAction.Allow }])
        );
        const tool = new ShellCommandTool(manager, system, workspace);

        const results = await tool.execute({ command: 'echo hi > /tmp/out', sessionId });
        expect(results).toHaveLength(1);
        expect(results[0]!.status).toBe(ResultStatus.Error);
        expect(results[0]!.result).toBe('Permission denied for: echo hi > /tmp/out');
    });

    describe('ShellCommandTool auto-create session', () => {
        function allow(rules: { pattern: string; action: PermissionAction }[]): PermissionSystem {
            return new PermissionSystem(createPermissionConfig(rules));
        }

        const echoAllowed = [{ pattern: 'echo *', action: PermissionAction.Allow }];

        it('creates a session and returns a delimited notice when sessionId is omitted', async () => {
            const tool = new ShellCommandTool(manager, allow(echoAllowed), workspace);

            const before = (await manager.listSessions()).length;
            const results = await tool.execute({ command: 'echo hello' });
            expect(results).toHaveLength(1);
            expect(results[0]!.status).toBe(ResultStatus.Success);
            const text = results[0]!.result ?? '';
            expect(text).toContain('[shell_command] new session: ');
            expect(text).toContain('[shell_command] --- begin output ---');
            expect(text).toContain('hello');
            expect(text).toContain('[shell_command] --- end output ---');

            const newId = /\[shell_command\] new session: (\S+)/.exec(text)?.[1];
            expect(newId).toBeDefined();
            expect((await manager.listSessions()).length).toBe(before + 1);
            expect((await manager.listSessions()).some((entry) => entry.id === newId)).toBe(true);
        });

        it('treats an empty sessionId as omitted', async () => {
            const tool = new ShellCommandTool(manager, allow(echoAllowed), workspace);
            const results = await tool.execute({ command: 'echo hi', sessionId: '' });
            expect(results[0]!.status).toBe(ResultStatus.Success);
            expect(results[0]!.result).toContain('[shell_command] new session: ');
        });

        it('treats a whitespace-only sessionId as omitted', async () => {
            const tool = new ShellCommandTool(manager, allow(echoAllowed), workspace);
            const results = await tool.execute({ command: 'echo hi', sessionId: '   ' });
            expect(results[0]!.status).toBe(ResultStatus.Success);
            expect(results[0]!.result).toContain('[shell_command] new session: ');
        });

        it('reuses the returned id in a follow-up call without the notice', async () => {
            const tool = new ShellCommandTool(manager, allow(echoAllowed), workspace);
            const first = await tool.execute({ command: 'echo one' });
            const newId = /\[shell_command\] new session: (\S+)/.exec(first[0]!.result ?? '')?.[1];
            if (newId === undefined) throw new Error('expected a session id');

            const second = await tool.execute({ command: 'echo two', sessionId: newId });
            expect(second[0]!.status).toBe(ResultStatus.Success);
            expect(second[0]!.result).toBe('two');
        });

        it('does not create a session when the command is denied', async () => {
            const tool = new ShellCommandTool(
                manager,
                allow([{ pattern: 'rm *', action: PermissionAction.Deny }]),
                workspace
            );

            const before = (await manager.listSessions()).length;
            const results = await tool.execute({ command: 'rm -rf /tmp' });
            expect(results[0]!.status).toBe(ResultStatus.Error);
            expect(results[0]!.result).toContain('Permission denied');
            expect((await manager.listSessions()).length).toBe(before);
        });

        it('keeps the not-found error and creates no session for an unknown id', async () => {
            const tool = new ShellCommandTool(
                manager,
                allow([{ pattern: '*', action: PermissionAction.Allow }]),
                workspace
            );

            const before = (await manager.listSessions()).length;
            const results = await tool.execute({ command: 'echo hi', sessionId: 'unknown-id' });
            expect(results[0]!.status).toBe(ResultStatus.Error);
            expect(results[0]!.result).toContain('Session not found: unknown-id');
            expect((await manager.listSessions()).length).toBe(before);
        });

        it('background without an id returns the new session id and the jobId', async () => {
            const tool = new ShellCommandTool(manager, allow(echoAllowed), workspace);

            const results = await tool.execute({ command: 'echo bg', background: true });
            expect(results[0]!.status).toBe(ResultStatus.Success);
            const text = results[0]!.result ?? '';
            expect(text).toMatch(/\[shell_command\] new session: \S+/);
            expect(text).toContain('Background job');
            expect(text).toContain('submitted');
        });

        it('reports the new id even when the command times out', async () => {
            const cfg = new ShellConfiguration();
            cfg.ctrlCTimeout = 500;
            const ws = createWorkspace(process.cwd());
            const mockManager = new ShellSessionManager(
                {
                    create: async () =>
                        new MockExecutor({
                            stdout: '',
                            stderr: '',
                            exitCode: -1,
                            timedOut: true,
                            sessionAlive: false,
                            idleTimeoutMs: 500
                        })
                },
                cfg,
                ws
            );
            const tool = new ShellCommandTool(
                mockManager,
                allow([{ pattern: 'sleep *', action: PermissionAction.Allow }]),
                ws
            );

            const results = await tool.execute({ command: 'sleep 10' });
            expect(results[0]!.status).toBe(ResultStatus.Error);
            const text = results[0]!.result ?? '';
            expect(text).toMatch(/\[shell_command\] new session: \S+/);
            expect(text).toContain('Command timed out and session was killed (idle limit: 500ms).');
            await mockManager.close();
        });

        it('reports the max-sessions error and returns no id when the cap is reached', async () => {
            const cfg = new ShellConfiguration();
            cfg.maxSessions = 1;
            const ws = createWorkspace(process.cwd());
            const capManager = new ShellSessionManager(
                { create: async () => new BashShellExecutor(new ShellConfiguration()) },
                cfg,
                ws
            );
            await capManager.createSession();
            const tool = new ShellCommandTool(
                capManager,
                allow([{ pattern: 'echo *', action: PermissionAction.Allow }]),
                ws
            );

            const results = await tool.execute({ command: 'echo hi' });
            expect(results[0]!.status).toBe(ResultStatus.Error);
            expect(results[0]!.result).toContain('Maximum sessions reached');
            expect(results[0]!.result).not.toContain('[shell_command] new session:');
            await capManager.close();
        });
    });
});
