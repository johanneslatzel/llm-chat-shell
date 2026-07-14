import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import { Workspace, DirectoryConfiguration, AccessType } from '@johannes.latzel/llm-chat-workspace';
import { ShellCreateTool } from '../../../src/tools/shell/shell-create-tool.js';
import { ShellSessionManager } from '../../../src/tools/shell/session-manager.js';
import { BashShellExecutor } from '../../../src/tools/shell/bash-executor.js';
import { ShellConfiguration } from '../../../src/tools/shell/config.js';
import { ResultStatus } from '@johannes.latzel/llm-chat';
import type { ShellExecutor } from '../../../src/tools/shell/types.js';
import type { ShellExecutorFactory } from '../../../src/tools/shell/session-manager.js';

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

describe('ShellCreateTool', () => {
    let created: ShellExecutor[];
    let manager: ShellSessionManager;
    let tool: ShellCreateTool;

    afterEach(async () => {
        for (const exec of created) {
            await exec.close();
        }
    });

    it('has correct name', async () => {
        created = [];
        const cfg = new ShellConfiguration();
        const factory: ShellExecutorFactory = {
            create: async () => {
                const exec = new BashShellExecutor(new ShellConfiguration());
                created.push(exec);
                return exec;
            }
        };
        manager = new ShellSessionManager(factory, cfg, createWorkspace(process.cwd()));
        tool = new ShellCreateTool(manager);
        expect(tool.name).toBe('shell_create');
    });

    it('creates a session and returns the ID', async () => {
        created = [];
        const cfg = new ShellConfiguration();
        const factory: ShellExecutorFactory = {
            create: async () => {
                const exec = new BashShellExecutor(new ShellConfiguration());
                created.push(exec);
                return exec;
            }
        };
        manager = new ShellSessionManager(factory, cfg, createWorkspace(process.cwd()));
        tool = new ShellCreateTool(manager);

        const results = await tool.execute({});
        expect(results).toHaveLength(1);
        expect(results[0]!.status).toBe(ResultStatus.Success);
        expect(typeof results[0]!.result).toBe('string');
    });

    it('passes cwd parameter to session manager', async () => {
        const receivedCwds: (string | undefined)[] = [];
        const cfg = new ShellConfiguration();
        const factory: ShellExecutorFactory = {
            create: async (cwd?: string) => {
                receivedCwds.push(cwd);
                return new BashShellExecutor(cfg);
            }
        };
        manager = new ShellSessionManager(factory, cfg, createWorkspace(process.cwd()));
        tool = new ShellCreateTool(manager);

        const results = await tool.execute({ cwd: 'src' });
        expect(results[0]!.status).toBe(ResultStatus.Success);
        expect(receivedCwds).toHaveLength(1);
        expect(receivedCwds[0]).toBe(path.resolve(process.cwd(), 'src'));
    });
});
