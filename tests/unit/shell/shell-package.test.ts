import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Workspace, DirectoryConfiguration, AccessType } from '@johannes.latzel/llm-chat-workspace';
import { ShellPackage } from '../../../src/tools/shell/shell-package.js';
import { ShellConfiguration } from '../../../src/tools/shell/config.js';
import { BashShellExecutor } from '../../../src/tools/shell/bash-executor.js';
import { ShellSessionManager } from '../../../src/tools/shell/session-manager.js';
import { PermissionAction } from '../../../src/tools/shell/types.js';
import type { ShellExecutor } from '../../../src/tools/shell/types.js';
import type { ShellExecutorFactory } from '../../../src/tools/shell/session-manager.js';
import { ResultStatus } from '@johannes.latzel/llm-chat';

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

describe('ShellPackage', () => {
    let managers: ShellSessionManager[] = [];

    afterEach(async () => {
        for (const m of managers) {
            await m.close();
        }
        managers = [];
    });

    it('creates with default config', () => {
        const pkg = new ShellPackage();
        const tools = pkg.tools();
        expect(tools).toHaveLength(6);
        expect(tools[0]!.name).toBe('shell_create');
        expect(tools[1]!.name).toBe('shell_command');
        expect(tools[2]!.name).toBe('shell_permissions');
        expect(tools[3]!.name).toBe('shell_job_status');
        expect(tools[4]!.name).toBe('shell_jobs');
        expect(tools[5]!.name).toBe('switch_workspace');
    });

    it('creates with custom config', () => {
        const config = new ShellConfiguration();
        config.permissionRules = [{ pattern: 'echo *', action: PermissionAction.Allow }];
        config.ctrlCTimeout = 10000;
        const pkg = new ShellPackage(config);
        expect(pkg.tools()).toHaveLength(6);
    });

    it('creates with empty permission rules (uses default)', () => {
        const config = new ShellConfiguration();
        config.permissionRules = [];
        config.defaultPermission = PermissionAction.Allow;
        const pkg = new ShellPackage(config);
        expect(pkg.tools()).toHaveLength(6);
    });

    it('accepts a custom session manager', async () => {
        const created: ShellExecutor[] = [];
        const factory: ShellExecutorFactory = {
            create: async (cwd?: string) => {
                const exec = new BashShellExecutor(cwd ? { ...new ShellConfiguration(), cwd } : new ShellConfiguration());
                created.push(exec);
                return exec;
            }
        };
        const cfg = new ShellConfiguration();
        const manager = new ShellSessionManager(factory, cfg, createWorkspace(process.cwd()));
        managers.push(manager);

        const pkg = new ShellPackage(undefined, manager);
        const createTool = pkg.tools().find((t) => t.name === 'shell_create')!;
        const results = await createTool.execute({});
        expect(results[0]!.status).toBe('success');
    });

    it('creates sessions using default factory when no manager provided', async () => {
        const pkg = new ShellPackage();
        const createTool = pkg.tools().find((t) => t.name === 'shell_create')!;
        const results = await createTool.execute({});
        expect(results[0]!.status).toBe('success');
    });

    it('creates sessions with cwd using default factory', async () => {
        const pkg = new ShellPackage();
        const createTool = pkg.tools().find((t) => t.name === 'shell_create')!;
        const results = await createTool.execute({ cwd: 'src' });
        expect(results[0]!.status).toBe(ResultStatus.Success);
    });

    it('exposes a working switch_workspace tool', async () => {
        const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-pkg-a-'));
        const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-pkg-b-'));
        try {
            const cfg = new ShellConfiguration();
            const workspace = new Workspace(
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
            const pkg = new ShellPackage(cfg, undefined, workspace);
            const switchTool = pkg.tools().find((t) => t.name === 'switch_workspace')!;

            let results = await switchTool.execute({ path: dirB });
            expect(results[0]!.status).toBe(ResultStatus.Success);
            expect(results[0]!.result).toContain(dirB);
            expect(workspace.currentPath).toBe(dirB);

            results = await switchTool.execute({ path: dirA });
            expect(results[0]!.status).toBe(ResultStatus.Success);
            expect(workspace.currentPath).toBe(dirA);
        } finally {
            fs.rmSync(dirA, { recursive: true, force: true });
            fs.rmSync(dirB, { recursive: true, force: true });
        }
    });

    it('dispose closes the session manager', async () => {
        const manager = new ShellSessionManager(
            { create: async () => new BashShellExecutor(new ShellConfiguration()) },
            new ShellConfiguration(),
            createWorkspace(process.cwd())
        );
        managers.push(manager);
        const disposeSpy = vi.spyOn(manager, 'dispose');

        const pkg = new ShellPackage(undefined, manager);
        await pkg.dispose();

        expect(disposeSpy).toHaveBeenCalledTimes(1);
    });
});

