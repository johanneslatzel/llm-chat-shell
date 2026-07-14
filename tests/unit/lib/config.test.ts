import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    ShellConfiguration,
    loadShellConfigFile
} from '../../../src/lib/config.js';
import { PermissionAction, PermissionAccess } from '../../../src/lib/types.js';

function clearEnv() {
    delete process.env['LLM_CHAT_SHELL_CTRL_C_TIMEOUT'];
    delete process.env['LLM_CHAT_SHELL_SIGTERM_TIMEOUT'];
    delete process.env['LLM_CHAT_SHELL_KILL_TIMEOUT'];
    delete process.env['LLM_CHAT_SHELL_MAX_SESSIONS'];
    delete process.env['LLM_CHAT_SHELL_SESSION_TIMEOUT'];
    delete process.env['LLM_CHAT_SHELL_BACKGROUND_TIMEOUT'];
    delete process.env['LLM_CHAT_SHELL_MAX_TIMEOUT'];
    delete process.env['LLM_CHAT_SHELL_CONFIG'];
}

let tempDir: string;

function writeConfig(contents: string): string {
    const file = join(tempDir, 'shell-config.json');
    writeFileSync(file, contents, 'utf8');
    return file;
}

describe('ShellConfiguration', () => {
    beforeEach(() => {
        clearEnv();
        tempDir = mkdtempSync(join(tmpdir(), 'llm-chat-shell-test-'));
    });

    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });

    it('has correct defaults when no env vars set', () => {
        const config = new ShellConfiguration();
        expect(config.configFilePath).toBeUndefined();
        expect(config.ctrlCTimeout).toBe(30000);
        expect(config.sigtermTimeout).toBe(5000);
        expect(config.killTimeout).toBe(5000);
        expect(config.maxSessions).toBe(10);
        expect(config.sessionTimeout).toBe(3600000);
        expect(config.backgroundTimeout).toBe(3600000);
        expect(config.maxTimeout).toBe(3600000);
        expect(config.defaultPermission).toBe(PermissionAction.Deny);
        expect(config.permissionRules).toEqual([]);
        expect(config.workspacePermissions.size).toBe(0);
    });

    it('reads LLM_CHAT_SHELL_CTRL_C_TIMEOUT from env', () => {
        process.env['LLM_CHAT_SHELL_CTRL_C_TIMEOUT'] = '10000';
        const config = new ShellConfiguration();
        expect(config.ctrlCTimeout).toBe(10000);
    });

    it('reads LLM_CHAT_SHELL_SIGTERM_TIMEOUT from env', () => {
        process.env['LLM_CHAT_SHELL_SIGTERM_TIMEOUT'] = '3000';
        const config = new ShellConfiguration();
        expect(config.sigtermTimeout).toBe(3000);
    });

    it('reads LLM_CHAT_SHELL_KILL_TIMEOUT from env', () => {
        process.env['LLM_CHAT_SHELL_KILL_TIMEOUT'] = '2000';
        const config = new ShellConfiguration();
        expect(config.killTimeout).toBe(2000);
    });

    it('reads LLM_CHAT_SHELL_MAX_SESSIONS from env', () => {
        process.env['LLM_CHAT_SHELL_MAX_SESSIONS'] = '5';
        const config = new ShellConfiguration();
        expect(config.maxSessions).toBe(5);
    });

    it('reads LLM_CHAT_SHELL_SESSION_TIMEOUT from env', () => {
        process.env['LLM_CHAT_SHELL_SESSION_TIMEOUT'] = '7200000';
        const config = new ShellConfiguration();
        expect(config.sessionTimeout).toBe(7200000);
    });

    it('reads LLM_CHAT_SHELL_BACKGROUND_TIMEOUT from env', () => {
        process.env['LLM_CHAT_SHELL_BACKGROUND_TIMEOUT'] = '900000';
        const config = new ShellConfiguration();
        expect(config.backgroundTimeout).toBe(900000);
    });

    it('reads LLM_CHAT_SHELL_MAX_TIMEOUT from env', () => {
        process.env['LLM_CHAT_SHELL_MAX_TIMEOUT'] = '300000';
        const config = new ShellConfiguration();
        expect(config.maxTimeout).toBe(300000);
    });

    it('uses default for invalid background timeout', () => {
        process.env['LLM_CHAT_SHELL_BACKGROUND_TIMEOUT'] = '-5';
        const config = new ShellConfiguration();
        expect(config.backgroundTimeout).toBe(3600000);
    });

    it('allows disabling the max timeout with zero', () => {
        process.env['LLM_CHAT_SHELL_MAX_TIMEOUT'] = '0';
        const config = new ShellConfiguration();
        expect(config.maxTimeout).toBe(0);
    });

    it('uses default for invalid timeout values', () => {
        process.env['LLM_CHAT_SHELL_CTRL_C_TIMEOUT'] = '-1';
        const config = new ShellConfiguration();
        expect(config.ctrlCTimeout).toBe(30000);
    });

    it('uses default for invalid max sessions', () => {
        process.env['LLM_CHAT_SHELL_MAX_SESSIONS'] = '0';
        const config = new ShellConfiguration();
        expect(config.maxSessions).toBe(10);
    });

    it('allows property overrides', () => {
        const config = new ShellConfiguration();
        config.ctrlCTimeout = 10000;
        config.sigtermTimeout = 3000;
        expect(config.ctrlCTimeout).toBe(10000);
        expect(config.sigtermTimeout).toBe(3000);
    });

    describe('config file', () => {
        it('reads configFilePath from LLM_CHAT_SHELL_CONFIG', () => {
            const file = writeConfig('{}');
            process.env['LLM_CHAT_SHELL_CONFIG'] = file;
            const config = new ShellConfiguration();
            expect(config.configFilePath).toBe(file);
        });

        it('loads global and per-workspace permission settings from the config file', () => {
            const file = writeConfig(
                JSON.stringify({
                    globalPermissions: {
                        defaultPermission: 'allow',
                        permissionRules: [
                            { pattern: 'git *', action: 'allow' },
                            { pattern: 'rm *', action: 'deny' }
                        ]
                    },
                    workspacePermissions: {
                        '/ws/a': {
                            defaultPermission: 'deny',
                            permissionRules: [{ pattern: 'git *', action: 'deny' }]
                        },
                        '/ws/b': { defaultPermission: 'allow', permissionRules: [] }
                    }
                })
            );
            process.env['LLM_CHAT_SHELL_CONFIG'] = file;
            const config = new ShellConfiguration();
            expect(config.defaultPermission).toBe(PermissionAction.Allow);
            expect(config.permissionRules).toEqual([
                { pattern: 'git *', action: 'allow' },
                { pattern: 'rm *', action: 'deny' }
            ]);
            expect(config.workspacePermissions.get('/ws/a')).toEqual({
                defaultPermission: 'deny',
                permissionRules: [{ pattern: 'git *', action: 'deny' }]
            });
            expect(config.workspacePermissions.get('/ws/b')).toEqual({
                defaultPermission: 'allow',
                permissionRules: []
            });
        });

        it('applies defaults when the config file has no globalPermissions', () => {
            const file = writeConfig(
                JSON.stringify({
                    workspacePermissions: {
                        '/ws/a': { defaultPermission: 'allow', permissionRules: [] }
                    }
                })
            );
            process.env['LLM_CHAT_SHELL_CONFIG'] = file;
            const config = new ShellConfiguration();
            expect(config.defaultPermission).toBe(PermissionAction.Deny);
            expect(config.permissionRules).toEqual([]);
            expect(config.workspacePermissions.get('/ws/a')).toEqual({
                defaultPermission: 'allow',
                permissionRules: []
            });
        });

        it('resolves workspacePermissions keys to absolute paths', () => {
            const file = writeConfig(
                JSON.stringify({
                    workspacePermissions: {
                        'relative/ws': { defaultPermission: 'allow', permissionRules: [] }
                    }
                })
            );
            process.env['LLM_CHAT_SHELL_CONFIG'] = file;
            const config = new ShellConfiguration();
            expect(config.workspacePermissions.has(join(process.cwd(), 'relative/ws'))).toBe(true);
        });

        it('resolves relative config file paths against process.cwd()', () => {
            const original = process.cwd();
            try {
                process.chdir(tempDir);
                writeConfig(
                    JSON.stringify({
                        globalPermissions: { defaultPermission: 'allow', permissionRules: [] }
                    })
                );
                process.env['LLM_CHAT_SHELL_CONFIG'] = 'shell-config.json';
                const config = new ShellConfiguration();
                expect(config.defaultPermission).toBe(PermissionAction.Allow);
            } finally {
                process.chdir(original);
            }
        });

        it('throws when the config file is missing', () => {
            process.env['LLM_CHAT_SHELL_CONFIG'] = join(tempDir, 'missing.json');
            expect(() => new ShellConfiguration()).toThrow(/Cannot read shell config file/);
        });

        it('throws when the config file contains invalid JSON', () => {
            const file = writeConfig('{ not json');
            process.env['LLM_CHAT_SHELL_CONFIG'] = file;
            expect(() => new ShellConfiguration()).toThrow(/Invalid JSON in shell config file/);
        });

        it('throws when the config file root is not an object', () => {
            const file = writeConfig('[1, 2]');
            process.env['LLM_CHAT_SHELL_CONFIG'] = file;
            expect(() => new ShellConfiguration()).toThrow(/must contain a JSON object/);
        });

        it('throws when globalPermissions is not an object', () => {
            const file = writeConfig('{ "globalPermissions": "deny" }');
            process.env['LLM_CHAT_SHELL_CONFIG'] = file;
            expect(() => new ShellConfiguration()).toThrow(
                /must be an object with 'defaultPermission' and 'permissionRules'/
            );
        });

        it('throws when globalPermissions.defaultPermission is invalid', () => {
            const file = writeConfig(
                '{ "globalPermissions": { "defaultPermission": "maybe", "permissionRules": [] } }'
            );
            process.env['LLM_CHAT_SHELL_CONFIG'] = file;
            expect(() => new ShellConfiguration()).toThrow(/defaultPermission must be 'allow' or 'deny'/);
        });

        it('throws when globalPermissions.permissionRules is not an array', () => {
            const file = writeConfig(
                '{ "globalPermissions": { "defaultPermission": "deny", "permissionRules": {} } }'
            );
            process.env['LLM_CHAT_SHELL_CONFIG'] = file;
            expect(() => new ShellConfiguration()).toThrow(/permissionRules must be an array/);
        });

        it('throws when a rule is not an object', () => {
            const file = writeConfig(
                '{ "globalPermissions": { "defaultPermission": "deny", "permissionRules": [42] } }'
            );
            process.env['LLM_CHAT_SHELL_CONFIG'] = file;
            expect(() => new ShellConfiguration()).toThrow(/must be an object with 'pattern' and 'action'/);
        });

        it('throws when a rule has a non-string pattern', () => {
            const file = writeConfig(
                '{ "globalPermissions": { "defaultPermission": "deny", "permissionRules": [{ "pattern": 42, "action": "allow" }] } }'
            );
            process.env['LLM_CHAT_SHELL_CONFIG'] = file;
            expect(() => new ShellConfiguration()).toThrow(/pattern must be a string/);
        });

        it('throws when a rule has an invalid action', () => {
            const file = writeConfig(
                '{ "globalPermissions": { "defaultPermission": "deny", "permissionRules": [{ "pattern": "git *", "action": "maybe" }] } }'
            );
            process.env['LLM_CHAT_SHELL_CONFIG'] = file;
            expect(() => new ShellConfiguration()).toThrow(/action must be 'allow' or 'deny'/);
        });

        it('parses a rule access of "write"', () => {
            const file = writeConfig(
                '{ "globalPermissions": { "defaultPermission": "deny", "permissionRules": [{ "pattern": "git push *", "action": "allow", "access": "write" }] } }'
            );
            process.env['LLM_CHAT_SHELL_CONFIG'] = file;
            const config = new ShellConfiguration();
            expect(config.permissionRules).toEqual([
                { pattern: 'git push *', action: PermissionAction.Allow, access: PermissionAccess.Write }
            ]);
        });

        it('parses a rule access of "read"', () => {
            const file = writeConfig(
                '{ "globalPermissions": { "defaultPermission": "deny", "permissionRules": [{ "pattern": "git *", "action": "allow", "access": "read" }] } }'
            );
            process.env['LLM_CHAT_SHELL_CONFIG'] = file;
            const config = new ShellConfiguration();
            expect(config.permissionRules).toEqual([
                { pattern: 'git *', action: PermissionAction.Allow, access: PermissionAccess.Read }
            ]);
        });

        it('omits access on a rule when it is not provided', () => {
            const file = writeConfig(
                '{ "globalPermissions": { "defaultPermission": "deny", "permissionRules": [{ "pattern": "git *", "action": "allow" }] } }'
            );
            process.env['LLM_CHAT_SHELL_CONFIG'] = file;
            const config = new ShellConfiguration();
            expect(config.permissionRules).toEqual([{ pattern: 'git *', action: PermissionAction.Allow }]);
        });

        it('throws when a rule has an invalid access', () => {
            const file = writeConfig(
                '{ "globalPermissions": { "defaultPermission": "deny", "permissionRules": [{ "pattern": "git *", "action": "allow", "access": "maybe" }] } }'
            );
            process.env['LLM_CHAT_SHELL_CONFIG'] = file;
            expect(() => new ShellConfiguration()).toThrow(/access must be 'read' or 'write'/);
        });

        it('parses access in per-workspace rules', () => {
            const file = writeConfig(
                '{ "workspacePermissions": { "/ws/a": { "defaultPermission": "deny", "permissionRules": [{ "pattern": "rm *", "action": "deny", "access": "write" }] } } }'
            );
            process.env['LLM_CHAT_SHELL_CONFIG'] = file;
            const config = new ShellConfiguration();
            expect(config.workspacePermissions.get('/ws/a')?.permissionRules).toEqual([
                { pattern: 'rm *', action: PermissionAction.Deny, access: PermissionAccess.Write }
            ]);
        });

        it('throws when workspacePermissions is not an object', () => {
            const file = writeConfig('{ "workspacePermissions": [] }');
            process.env['LLM_CHAT_SHELL_CONFIG'] = file;
            expect(() => new ShellConfiguration()).toThrow(
                /workspacePermissions must be an object keyed by workspace root/
            );
        });

        it('throws when a workspace entry is not an object', () => {
            const file = writeConfig('{ "workspacePermissions": { "/ws/a": 42 } }');
            process.env['LLM_CHAT_SHELL_CONFIG'] = file;
            expect(() => new ShellConfiguration()).toThrow(
                /must be an object with 'defaultPermission' and 'permissionRules'/
            );
        });

        it('throws when a workspace entry is missing fields', () => {
            const file = writeConfig(
                '{ "workspacePermissions": { "/ws/a": { "defaultPermission": "allow" } } }'
            );
            process.env['LLM_CHAT_SHELL_CONFIG'] = file;
            expect(() => new ShellConfiguration()).toThrow(/permissionRules must be an array/);
        });
    });

    describe('resolvePermissions', () => {
        it('returns per-workspace settings for a configured root', () => {
            const config = new ShellConfiguration();
            config.defaultPermission = PermissionAction.Allow;
            config.workspacePermissions.set('/ws/a', {
                defaultPermission: PermissionAction.Deny,
                permissionRules: []
            });
            expect(config.resolvePermissions('/ws/a').defaultPermission).toBe(PermissionAction.Deny);
        });

        it('falls back to global settings for an unknown root', () => {
            const config = new ShellConfiguration();
            config.defaultPermission = PermissionAction.Allow;
            config.permissionRules = [{ pattern: 'ls *', action: PermissionAction.Allow }];
            expect(config.resolvePermissions('/unknown').defaultPermission).toBe(
                PermissionAction.Allow
            );
            expect(config.resolvePermissions('/unknown').permissionRules).toEqual([
                { pattern: 'ls *', action: PermissionAction.Allow }
            ]);
        });

        it('falls back to global settings for empty root', () => {
            const config = new ShellConfiguration();
            config.defaultPermission = PermissionAction.Allow;
            expect(config.resolvePermissions('').defaultPermission).toBe(PermissionAction.Allow);
        });
    });

    describe('resolveIdleTimeout', () => {
        it('uses ctrlCTimeout for foreground commands without a requested timeout', () => {
            const config = new ShellConfiguration();
            config.ctrlCTimeout = 1000;
            expect(config.resolveIdleTimeout(false)).toBe(1000);
        });

        it('uses backgroundTimeout for background jobs without a requested timeout', () => {
            const config = new ShellConfiguration();
            config.backgroundTimeout = 60000;
            expect(config.resolveIdleTimeout(true)).toBe(60000);
        });

        it('uses the requested timeout when below the max', () => {
            const config = new ShellConfiguration();
            config.maxTimeout = 3600000;
            expect(config.resolveIdleTimeout(false, 5000)).toBe(5000);
        });

        it('caps the requested timeout at maxTimeout', () => {
            const config = new ShellConfiguration();
            config.maxTimeout = 30000;
            expect(config.resolveIdleTimeout(false, 60000)).toBe(30000);
        });

        it('does not cap the requested timeout when maxTimeout is 0', () => {
            const config = new ShellConfiguration();
            config.maxTimeout = 0;
            expect(config.resolveIdleTimeout(false, 60000)).toBe(60000);
        });

        it('ignores a non-positive requested timeout', () => {
            const config = new ShellConfiguration();
            config.backgroundTimeout = 60000;
            config.ctrlCTimeout = 1000;
            expect(config.resolveIdleTimeout(true, 0)).toBe(60000);
            expect(config.resolveIdleTimeout(true, -5)).toBe(60000);
            expect(config.resolveIdleTimeout(false, -5)).toBe(1000);
        });
    });
});

describe('loadShellConfigFile', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'llm-chat-shell-test-'));
    });

    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });

    it('returns the parsed config for a valid file', () => {
        const file = join(tempDir, 'config.json');
        writeFileSync(
            file,
            JSON.stringify({
                globalPermissions: {
                    defaultPermission: 'deny',
                    permissionRules: [{ pattern: 'git *', action: 'allow' }]
                }
            }),
            'utf8'
        );
        expect(loadShellConfigFile(file)).toEqual({
            globalPermissions: {
                defaultPermission: 'deny',
                permissionRules: [{ pattern: 'git *', action: 'allow' }]
            }
        });
    });

    it('returns an empty config for an empty object', () => {
        const file = join(tempDir, 'config.json');
        writeFileSync(file, '{}', 'utf8');
        expect(loadShellConfigFile(file)).toEqual({});
    });

    it('throws when the file cannot be read', () => {
        expect(() => loadShellConfigFile(join(tempDir, 'missing.json'))).toThrow(
            /Cannot read shell config file/
        );
    });

    it('throws on invalid JSON', () => {
        const file = join(tempDir, 'config.json');
        writeFileSync(file, 'not-json', 'utf8');
        expect(() => loadShellConfigFile(file)).toThrow(/Invalid JSON in shell config file/);
    });
});
