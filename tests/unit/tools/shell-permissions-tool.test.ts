import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { Workspace, DirectoryConfiguration, AccessType } from '@johannes.latzel/llm-chat-workspace';
import { ShellPermissionsTool } from '../../../src/tools/shell-permissions-tool.js';
import { ShellConfiguration } from '../../../src/lib/config.js';
import { PermissionAction, PermissionAccess } from '../../../src/lib/types.js';

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

describe('ShellPermissionsTool', () => {
    it('returns current workspace and default action with no rules', async () => {
        const config = new ShellConfiguration();
        config.permissionRules = [];
        config.defaultPermission = PermissionAction.Deny;

        const tool = new ShellPermissionsTool(config, createWorkspace(process.cwd()));
        const results = await tool.execute({});

        expect(results[0]!.status).toBe('success');
        expect(results[0]!.result).toBe(`Workspace: ${process.cwd()}\nDefault: deny`);
    });

    it('returns rules and default action', async () => {
        const config = new ShellConfiguration();
        config.defaultPermission = PermissionAction.Deny;
        config.permissionRules = [
            { pattern: 'git *', action: PermissionAction.Allow },
            { pattern: 'rm *', action: PermissionAction.Deny }
        ];

        const tool = new ShellPermissionsTool(config, createWorkspace(process.cwd()));
        const results = await tool.execute({});

        expect(results[0]!.status).toBe('success');
        expect(results[0]!.result).toBe(
            `Workspace: ${process.cwd()}\nDefault: deny\nRules:\n1. git * → allow\n2. rm * → deny`
        );
    });

    it('reports the access tier on write rules', async () => {
        const config = new ShellConfiguration();
        config.defaultPermission = PermissionAction.Deny;
        config.permissionRules = [
            { pattern: 'git *', action: PermissionAction.Allow },
            { pattern: 'git push *', action: PermissionAction.Allow, access: PermissionAccess.Write }
        ];

        const tool = new ShellPermissionsTool(config, createWorkspace(process.cwd()));
        const results = await tool.execute({});

        expect(results[0]!.result).toBe(
            `Workspace: ${process.cwd()}\nDefault: deny\nRules:\n1. git * → allow\n2. git push * → allow (write)`
        );
    });

    it('reflects config changes', async () => {
        const config = new ShellConfiguration();
        config.defaultPermission = PermissionAction.Allow;
        config.permissionRules = [];

        const tool = new ShellPermissionsTool(config, createWorkspace(process.cwd()));

        let results = await tool.execute({});
        expect(results[0]!.result).toBe(`Workspace: ${process.cwd()}\nDefault: allow`);

        config.permissionRules = [{ pattern: 'ls *', action: PermissionAction.Deny }];
        results = await tool.execute({});
        expect(results[0]!.result).toBe(
            `Workspace: ${process.cwd()}\nDefault: allow\nRules:\n1. ls * → deny`
        );
    });

    it('reports per-workspace rules for the current workspace root', async () => {
        const config = new ShellConfiguration();
        config.defaultPermission = PermissionAction.Allow;
        config.workspacePermissions.set(process.cwd(), {
            defaultPermission: PermissionAction.Deny,
            permissionRules: [{ pattern: 'git *', action: PermissionAction.Allow }]
        });

        const tool = new ShellPermissionsTool(config, createWorkspace(process.cwd()));
        const results = await tool.execute({});

        expect(results[0]!.result).toBe(
            `Workspace: ${process.cwd()}\nDefault: deny\nRules:\n1. git * → allow`
        );
    });

    it('reports the workspace root when the current path is nested', async () => {
        const root = process.cwd();
        const nested = path.join(root, 'src');
        const config = new ShellConfiguration();
        const workspace = new Workspace(
            new DirectoryConfiguration(
                [{ type: AccessType.Write, path: root }],
                [],
                false,
                nested
            )
        );

        const tool = new ShellPermissionsTool(config, workspace);
        const results = await tool.execute({});

        expect(results[0]!.result).toBe(
            `Workspace: ${nested}\nWorkspace root: ${root}\nDefault: deny`
        );
    });

    it('falls back to the current path when it is outside all access roots', async () => {
        const root = path.resolve('ws-inside');
        const outside = path.resolve('ws-outside');
        const config = new ShellConfiguration();
        const workspace = new Workspace(
            new DirectoryConfiguration(
                [{ type: AccessType.Write, path: root }],
                [],
                false,
                outside
            )
        );

        const tool = new ShellPermissionsTool(config, workspace);
        const results = await tool.execute({});

        expect(results[0]!.result).toBe(`Workspace: ${outside}\nDefault: deny`);
    });
});
