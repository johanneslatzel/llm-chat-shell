import { describe, it, expect } from 'vitest';
import {
    parseSubcommands,
    PermissionSystem,
    workspaceForPath
} from '../../../src/lib/permission.js';
import { PermissionAction, PermissionAccess, PermissionDenyReason } from '../../../src/lib/types.js';
import { ShellConfiguration } from '../../../src/lib/config.js';

describe('workspaceForPath', () => {
    it('returns empty string when cwd is outside all access roots', () => {
        expect(workspaceForPath('/elsewhere', ['/ws/a', '/ws/b'])).toBe('');
    });

    it('returns the containing access root', () => {
        expect(workspaceForPath('/ws/a/sub', ['/ws/a', '/ws/b'])).toBe('/ws/a');
    });

    it('returns the deepest containing access root', () => {
        expect(workspaceForPath('/ws/a/deep/nested', ['/ws/a', '/ws/a/deep'])).toBe('/ws/a/deep');
    });

    it('keeps the deepest match when a shallower root is compared after a deeper one', () => {
        expect(workspaceForPath('/ws/a/deep/nested', ['/ws/a/deep', '/ws/a'])).toBe('/ws/a/deep');
    });

    it('matches the root itself', () => {
        expect(workspaceForPath('/ws/a', ['/ws/a'])).toBe('/ws/a');
    });

    it('resolves relative cwd against process.cwd()', () => {
        const cwd = process.cwd();
        expect(workspaceForPath('src', [cwd])).toBe(cwd);
    });

    it('resolves relative access roots against process.cwd()', () => {
        const cwd = process.cwd();
        expect(workspaceForPath(cwd, ['.'])).toBe(cwd);
    });

    it('does not confuse a sibling prefix with containment', () => {
        expect(workspaceForPath('/ws/abc', ['/ws/a'])).toBe('');
    });

    it('resolves access roots before matching', () => {
        expect(workspaceForPath('/ws/a/sub', ['/ws/a/'])).toBe('/ws/a');
    });

    it('treats the filesystem root as containing every path', () => {
        expect(workspaceForPath('/any/where', ['/'])).toBe('/');
    });
});

describe('parseSubcommands', () => {
    describe('empty and simple', () => {
        it('returns empty array for empty string', () => {
            expect(parseSubcommands('')).toEqual([]);
        });

        it('returns empty array for whitespace-only', () => {
            expect(parseSubcommands('   ')).toEqual([]);
        });

        it('parses a single command', () => {
            expect(parseSubcommands('ls')).toEqual(['ls']);
        });

        it('trims whitespace', () => {
            expect(parseSubcommands('  ls -la  ')).toEqual(['ls -la']);
        });
    });

    describe('&& splitting', () => {
        it('splits on &&', () => {
            expect(parseSubcommands('cmd1 && cmd2')).toEqual(['cmd1', 'cmd2']);
        });

        it('splits on multiple &&', () => {
            expect(parseSubcommands('cmd1 && cmd2 && cmd3')).toEqual(['cmd1', 'cmd2', 'cmd3']);
        });
    });

    describe('|| splitting', () => {
        it('splits on ||', () => {
            expect(parseSubcommands('cmd1 || cmd2')).toEqual(['cmd1', 'cmd2']);
        });
    });

    describe('| splitting', () => {
        it('splits on |', () => {
            expect(parseSubcommands('ls -la | grep foo')).toEqual(['ls -la', 'grep foo']);
        });
    });

    describe('; splitting', () => {
        it('splits on ;', () => {
            expect(parseSubcommands('cmd1; cmd2')).toEqual(['cmd1', 'cmd2']);
        });

        it('handles ; with no space', () => {
            expect(parseSubcommands('cmd1;cmd2')).toEqual(['cmd1', 'cmd2']);
        });
    });

    describe('mixed operators', () => {
        it('handles && and ||', () => {
            expect(parseSubcommands('cmd1 && cmd2 || cmd3')).toEqual(['cmd1', 'cmd2', 'cmd3']);
        });

        it('handles all operators', () => {
            expect(parseSubcommands('cmd1 && cmd2 || cmd3; cmd4 | cmd5')).toEqual([
                'cmd1',
                'cmd2',
                'cmd3',
                'cmd4',
                'cmd5'
            ]);
        });
    });

    describe('quoted strings', () => {
        it('does not split on operators inside double quotes', () => {
            expect(parseSubcommands('echo "hello && world"')).toEqual(['echo "hello && world"']);
        });

        it('does not split on operators inside single quotes', () => {
            expect(parseSubcommands("echo 'hello || world'")).toEqual(["echo 'hello || world'"]);
        });

        it('handles quoted operator then real operator', () => {
            expect(parseSubcommands('command1 --arg "&&" && command2')).toEqual([
                'command1 --arg "&&"',
                'command2'
            ]);
        });

        it('handles pipe inside quotes', () => {
            expect(parseSubcommands('echo "a | b" | grep a')).toEqual(['echo "a | b"', 'grep a']);
        });

        it('handles semicolon inside quotes', () => {
            expect(parseSubcommands("echo 'a; b' && ls")).toEqual(["echo 'a; b'", 'ls']);
        });
    });

    describe('escape sequences', () => {
        it('handles escaped double quote inside double quotes', () => {
            const input = String.raw`echo "foo\"bar" && ls`;
            expect(parseSubcommands(input)).toEqual([String.raw`echo "foo\"bar"`, 'ls']);
        });

        it('handles escaped single quote inside single quotes', () => {
            const input = String.raw`echo 'foo\'bar' && ls`;
            expect(parseSubcommands(input)).toEqual([String.raw`echo 'foo\'bar'`, 'ls']);
        });

        it('handles different quote type inside current quote as literal', () => {
            expect(parseSubcommands('echo "don\'t"')).toEqual(['echo "don\'t"']);
        });

        it('handles opposite quote nesting', () => {
            expect(parseSubcommands('echo \'he said "hi"\'')).toEqual(['echo \'he said "hi"\'']);
        });
    });

    describe('adjacent chars around quotes', () => {
        it('accepts chars before opening quote', () => {
            expect(parseSubcommands('foo"bar" && ls')).toEqual(['foo"bar"', 'ls']);
        });

        it('accepts chars after closing quote', () => {
            expect(parseSubcommands('"foo"bar && ls')).toEqual(['"foo"bar', 'ls']);
        });
    });

    describe('redirect stripping', () => {
        it('strips 2>&1 stderr-to-stdout redirect', () => {
            expect(parseSubcommands('cmd 2>&1')).toEqual(['cmd']);
        });

        it('strips &> stdout+stderr redirect', () => {
            expect(parseSubcommands('cmd &>file.txt')).toEqual(['cmd']);
        });

        it('strips >> stdout append redirect', () => {
            expect(parseSubcommands('cmd >>file.txt')).toEqual(['cmd']);
        });

        it('strips 2>> stderr append redirect', () => {
            expect(parseSubcommands('cmd 2>>log.txt')).toEqual(['cmd']);
        });

        it('strips < stdin redirect', () => {
            expect(parseSubcommands('cmd <input.txt')).toEqual(['cmd']);
        });

        it('strips &> with /dev/null target', () => {
            expect(parseSubcommands('cmd &>/dev/null')).toEqual(['cmd']);
        });

        it('strips the earliest redirect when multiple are present', () => {
            expect(parseSubcommands('cmd >out 2>&1')).toEqual(['cmd']);
        });

        it('strips 2>&1 before > when 2>&1 comes first', () => {
            expect(parseSubcommands('cmd 2>&1 >out')).toEqual(['cmd']);
        });

        it('does not confuse 2>&1 with &>', () => {
            expect(parseSubcommands('cmd 2>&1 | grep foo')).toEqual(['cmd', 'grep foo']);
        });

        it('handles redirect stripping across piped commands', () => {
            expect(parseSubcommands('cmd >out | grep foo 2>&1')).toEqual(['cmd', 'grep foo']);
        });

        it('strips redirect with no space before target', () => {
            expect(parseSubcommands('cmd >/tmp/out')).toEqual(['cmd']);
        });

        it('strips 2>/dev/null', () => {
            expect(parseSubcommands('cmd 2>/dev/null')).toEqual(['cmd']);
        });

        it('skips empty subcommand after && when only redirects remain', () => {
            expect(parseSubcommands('> /dev/null && echo hi')).toEqual(['echo hi']);
        });

        it('skips empty subcommand after || when only redirects remain', () => {
            expect(parseSubcommands('> /dev/null || echo hi')).toEqual(['echo hi']);
        });

        it('skips empty subcommand after | when only redirects remain', () => {
            expect(parseSubcommands('> /dev/null | echo hi')).toEqual(['echo hi']);
        });

        it('skips empty subcommand after ; when only redirects remain', () => {
            expect(parseSubcommands('> /dev/null; echo hi')).toEqual(['echo hi']);
        });

        it('skips entirely redirect-only input', () => {
            expect(parseSubcommands('> /dev/null')).toEqual([]);
        });

        it('skips redirect-only prefix in flush', () => {
            expect(parseSubcommands('echo hi > /dev/null')).toEqual(['echo hi']);
        });
    });
});

describe('PermissionSystem', () => {
    function createConfig(
        rules: { pattern: string; action: PermissionAction; access?: PermissionAccess }[],
        defaultAction = PermissionAction.Deny
    ): ShellConfiguration {
        const cfg = new ShellConfiguration();
        cfg.permissionRules = rules;
        cfg.defaultPermission = defaultAction;
        return cfg;
    }

    it('allows a command matching an allow rule', () => {
        const system = new PermissionSystem(
            createConfig([{ pattern: 'ls', action: PermissionAction.Allow }])
        );
        expect(system.check('ls').action).toBe(PermissionAction.Allow);
    });

    it('denies a command matching a deny rule', () => {
        const system = new PermissionSystem(
            createConfig([{ pattern: 'rm *', action: PermissionAction.Deny }])
        );
        expect(system.check('rm -rf /tmp/foo').action).toBe(PermissionAction.Deny);
    });

    it('denies empty command', () => {
        const system = new PermissionSystem(
            createConfig([{ pattern: '*', action: PermissionAction.Allow }])
        );
        expect(system.check('').action).toBe(PermissionAction.Deny);
    });

    it('allows composed command when all subcommands are allowed', () => {
        const system = new PermissionSystem(
            createConfig([
                { pattern: 'git *', action: PermissionAction.Allow },
                { pattern: 'echo *', action: PermissionAction.Allow }
            ])
        );
        expect(system.check('git add . && echo "done"').action).toBe(PermissionAction.Allow);
    });

    it('denies composed command when any subcommand is denied', () => {
        const system = new PermissionSystem(
            createConfig([
                { pattern: 'git *', action: PermissionAction.Allow },
                { pattern: 'rm *', action: PermissionAction.Deny }
            ])
        );
        expect(system.check('git add . && rm -rf /tmp').action).toBe(PermissionAction.Deny);
    });

    it('matches glob patterns', () => {
        const system = new PermissionSystem(
            createConfig([{ pattern: 'git *', action: PermissionAction.Allow }])
        );
        expect(system.check('git add .').action).toBe(PermissionAction.Allow);
        expect(system.check('git push origin main').action).toBe(PermissionAction.Allow);
        expect(system.check('git').action).toBe(PermissionAction.Deny);
    });

    it('uses default action for unmatched commands', () => {
        const system = new PermissionSystem(createConfig([], PermissionAction.Deny));
        expect(system.check('unknown-cmd').action).toBe(PermissionAction.Deny);
    });

    it('respects default action override', () => {
        const system = new PermissionSystem(createConfig([], PermissionAction.Allow));
        expect(system.check('unknown-cmd').action).toBe(PermissionAction.Allow);
    });

    it('returns subcommands in result', () => {
        const system = new PermissionSystem(
            createConfig([{ pattern: '*', action: PermissionAction.Allow }])
        );
        const result = system.check('ls | grep foo');
        expect(result.subcommands).toEqual(['ls', 'grep foo']);
    });

    it('handles redirect stripping in permission check', () => {
        const system = new PermissionSystem(
            createConfig([
                { pattern: 'echo *', action: PermissionAction.Allow },
                { pattern: 'rm *', action: PermissionAction.Deny }
            ])
        );
        expect(system.check('echo hello > /tmp/out').action).toBe(PermissionAction.Allow);
    });

    it('handles pipe + redirect', () => {
        const system = new PermissionSystem(
            createConfig([
                { pattern: 'ls', action: PermissionAction.Allow },
                { pattern: 'grep *', action: PermissionAction.Allow }
            ])
        );
        expect(system.check('ls | grep foo > /tmp/out').action).toBe(PermissionAction.Allow);
    });

    it('handles stderr redirect', () => {
        const system = new PermissionSystem(
            createConfig([{ pattern: 'ls', action: PermissionAction.Allow }])
        );
        expect(system.check('ls 2>/dev/null').action).toBe(PermissionAction.Allow);
    });

    it('matches ? glob pattern', () => {
        const system = new PermissionSystem(
            createConfig([{ pattern: 'ls ?', action: PermissionAction.Allow }])
        );
        expect(system.check('ls a').action).toBe(PermissionAction.Allow);
        expect(system.check('ls ab').action).toBe(PermissionAction.Deny);
    });

    it('strips quoted redirect targets', () => {
        const system = new PermissionSystem(
            createConfig([{ pattern: 'echo *', action: PermissionAction.Allow }])
        );
        expect(system.check('echo hello > "file name"').action).toBe(PermissionAction.Allow);
    });

    it('strips single-quoted redirect targets', () => {
        const system = new PermissionSystem(
            createConfig([{ pattern: 'echo *', action: PermissionAction.Allow }])
        );
        expect(system.check("echo hello > 'file name'").action).toBe(PermissionAction.Allow);
    });

    it('strips quoted redirect targets with escaped chars', () => {
        const system = new PermissionSystem(
            createConfig([{ pattern: 'echo *', action: PermissionAction.Allow }])
        );
        expect(system.check(String.raw`echo hello > "file\"name"`).action).toBe(
            PermissionAction.Allow
        );
    });

    describe('best-match specificity — criterion 1: dominance', () => {
        it('dominant pattern wins regardless of rule order (concrete > general)', () => {
            const system = new PermissionSystem(
                createConfig([
                    { pattern: 'git *', action: PermissionAction.Allow },
                    { pattern: 'git push *', action: PermissionAction.Deny }
                ])
            );
            expect(system.check('git push origin main').action).toBe(PermissionAction.Deny);
            expect(system.check('git add .').action).toBe(PermissionAction.Allow);
        });

        it('dominant pattern wins in reverse order too', () => {
            const system = new PermissionSystem(
                createConfig([
                    { pattern: 'git push *', action: PermissionAction.Deny },
                    { pattern: 'git *', action: PermissionAction.Allow }
                ])
            );
            expect(system.check('git push origin main').action).toBe(PermissionAction.Deny);
        });

        it('literal command dominates wildcard pattern', () => {
            const system = new PermissionSystem(
                createConfig([
                    { pattern: 'git *', action: PermissionAction.Allow },
                    { pattern: 'git push', action: PermissionAction.Deny }
                ])
            );
            expect(system.check('git push').action).toBe(PermissionAction.Deny);
        });

        it('literal command dominates wildcard pattern regardless of order', () => {
            const system = new PermissionSystem(
                createConfig([
                    { pattern: 'git push', action: PermissionAction.Deny },
                    { pattern: 'git *', action: PermissionAction.Allow }
                ])
            );
            expect(system.check('git push').action).toBe(PermissionAction.Deny);
        });

        it('more specific wildcard pattern wins over general wildcard', () => {
            const system = new PermissionSystem(
                createConfig([
                    { pattern: 'rm *', action: PermissionAction.Allow },
                    { pattern: 'rm -rf *', action: PermissionAction.Deny }
                ])
            );
            expect(system.check('rm -rf /tmp/foo').action).toBe(PermissionAction.Deny);
            expect(system.check('rm file.txt').action).toBe(PermissionAction.Allow);
        });

        it('wildcard-only pattern is dominated by any prefix pattern', () => {
            const system = new PermissionSystem(
                createConfig([
                    { pattern: '*', action: PermissionAction.Allow },
                    { pattern: 'git *', action: PermissionAction.Deny }
                ])
            );
            expect(system.check('git add .').action).toBe(PermissionAction.Deny);
        });

        it('wildcard-only pattern dominates nothing', () => {
            const system = new PermissionSystem(
                createConfig([
                    { pattern: 'git *', action: PermissionAction.Allow },
                    { pattern: '*', action: PermissionAction.Deny }
                ])
            );
            expect(system.check('git add .').action).toBe(PermissionAction.Allow);
        });
    });

    describe('best-match specificity — criterion 2: wildcard count', () => {
        it('fewer wildcards wins when neither dominates', () => {
            const system = new PermissionSystem(
                createConfig([
                    { pattern: 'ls * *', action: PermissionAction.Deny },
                    { pattern: 'ls ?', action: PermissionAction.Allow }
                ])
            );
            expect(system.check('ls a').action).toBe(PermissionAction.Allow);
        });

        it('no wildcards beats one wildcard', () => {
            const system = new PermissionSystem(
                createConfig([
                    { pattern: 'ls *', action: PermissionAction.Deny },
                    { pattern: 'ls a', action: PermissionAction.Allow }
                ])
            );
            expect(system.check('ls a').action).toBe(PermissionAction.Allow);
        });

        it('zero wildcards beats two wildcards', () => {
            const system = new PermissionSystem(
                createConfig([
                    { pattern: '* *', action: PermissionAction.Deny },
                    { pattern: 'ls a', action: PermissionAction.Allow }
                ])
            );
            expect(system.check('ls a').action).toBe(PermissionAction.Allow);
        });
    });

    describe('best-match specificity — criterion 3: literal character count', () => {
        it('more literal characters wins when wildcard counts are equal', () => {
            const system = new PermissionSystem(
                createConfig([
                    { pattern: 'git p*', action: PermissionAction.Deny },
                    { pattern: 'git push *', action: PermissionAction.Allow }
                ])
            );
            expect(system.check('git push origin main').action).toBe(PermissionAction.Allow);
        });

        it('more literal characters wins in reverse order', () => {
            const system = new PermissionSystem(
                createConfig([
                    { pattern: 'git push *', action: PermissionAction.Allow },
                    { pattern: 'git p*', action: PermissionAction.Deny }
                ])
            );
            expect(system.check('git push origin main').action).toBe(PermissionAction.Allow);
        });

        it('longer literal prefix beats shorter literal prefix', () => {
            const system = new PermissionSystem(
                createConfig([
                    { pattern: 'rm -r*', action: PermissionAction.Allow },
                    { pattern: 'rm -rf *', action: PermissionAction.Deny }
                ])
            );
            expect(system.check('rm -rf /tmp/foo').action).toBe(PermissionAction.Deny);
        });
    });

    describe('best-match specificity — criterion 4: first declared', () => {
        it('first declared rule wins when all other criteria are equal', () => {
            const system = new PermissionSystem(
                createConfig([
                    { pattern: 'git push *', action: PermissionAction.Allow },
                    { pattern: 'git push *', action: PermissionAction.Deny }
                ])
            );
            expect(system.check('git push origin main').action).toBe(PermissionAction.Allow);
        });

        it('first declared rule wins when patterns are identical', () => {
            const system = new PermissionSystem(
                createConfig([
                    { pattern: 'ls *', action: PermissionAction.Deny },
                    { pattern: 'ls *', action: PermissionAction.Allow }
                ])
            );
            expect(system.check('ls -la').action).toBe(PermissionAction.Deny);
        });
    });

    describe('best-match specificity — combined scenarios', () => {
        it('three-tier specificity: literal > specific wildcard > general wildcard', () => {
            const system = new PermissionSystem(
                createConfig([
                    { pattern: 'git *', action: PermissionAction.Allow },
                    { pattern: 'git push *', action: PermissionAction.Deny },
                    { pattern: 'git push origin main', action: PermissionAction.Allow }
                ])
            );
            expect(system.check('git push origin main').action).toBe(PermissionAction.Allow);
            expect(system.check('git push dev').action).toBe(PermissionAction.Deny);
            expect(system.check('git add .').action).toBe(PermissionAction.Allow);
        });

        it('three-tier specificity in reverse declaration order', () => {
            const system = new PermissionSystem(
                createConfig([
                    { pattern: 'git push origin main', action: PermissionAction.Allow },
                    { pattern: 'git push *', action: PermissionAction.Deny },
                    { pattern: 'git *', action: PermissionAction.Allow }
                ])
            );
            expect(system.check('git push origin main').action).toBe(PermissionAction.Allow);
            expect(system.check('git push dev').action).toBe(PermissionAction.Deny);
            expect(system.check('git add .').action).toBe(PermissionAction.Allow);
        });

        it('competing deny and allow across specificity levels', () => {
            const system = new PermissionSystem(
                createConfig([
                    { pattern: 'rm *', action: PermissionAction.Allow },
                    { pattern: 'rm -rf *', action: PermissionAction.Deny }
                ])
            );
            expect(system.check('rm file.txt').action).toBe(PermissionAction.Allow);
            expect(system.check('rm -rf /tmp/foo').action).toBe(PermissionAction.Deny);
        });

        it('wildcard count breaks tie when dominance is symmetric', () => {
            const system = new PermissionSystem(
                createConfig([
                    { pattern: '* push *', action: PermissionAction.Deny },
                    { pattern: 'git * main', action: PermissionAction.Allow }
                ])
            );
            expect(system.check('git push main').action).toBe(PermissionAction.Allow);
        });

        it('literal count breaks tie when wildcard counts are equal', () => {
            const system = new PermissionSystem(
                createConfig([
                    { pattern: 'gi* push *', action: PermissionAction.Deny },
                    { pattern: 'git pu* main', action: PermissionAction.Allow }
                ])
            );
            expect(system.check('git push main').action).toBe(PermissionAction.Allow);
        });

        it('complex multi-rule scenario with mixed specificity', () => {
            const system = new PermissionSystem(
                createConfig([
                    { pattern: '*', action: PermissionAction.Deny },
                    { pattern: 'git *', action: PermissionAction.Allow },
                    { pattern: 'git push *', action: PermissionAction.Deny },
                    { pattern: 'git push origin main', action: PermissionAction.Allow }
                ])
            );
            expect(system.check('ls').action).toBe(PermissionAction.Deny);
            expect(system.check('git add .').action).toBe(PermissionAction.Allow);
            expect(system.check('git push dev').action).toBe(PermissionAction.Deny);
            expect(system.check('git push origin main').action).toBe(PermissionAction.Allow);
        });
    });

    describe('per-workspace resolution', () => {
        it('uses workspace rules when a workspace root is provided', () => {
            const cfg = createConfig([{ pattern: 'git *', action: PermissionAction.Allow }]);
            cfg.workspacePermissions.set('/ws/a', {
                defaultPermission: PermissionAction.Allow,
                permissionRules: [{ pattern: 'git *', action: PermissionAction.Deny }]
            });
            const system = new PermissionSystem(cfg);

            expect(system.check('git add .', '/ws/a').action).toBe(PermissionAction.Deny);
            expect(system.check('echo hi', '/ws/a').action).toBe(PermissionAction.Allow);
        });

        it('uses workspace default permission for unmatched commands', () => {
            const cfg = createConfig([], PermissionAction.Deny);
            cfg.workspacePermissions.set('/ws/a', {
                defaultPermission: PermissionAction.Allow,
                permissionRules: []
            });
            const system = new PermissionSystem(cfg);

            expect(system.check('unknown-cmd', '/ws/a').action).toBe(PermissionAction.Allow);
        });

        it('falls back to global settings when workspace root has no entry', () => {
            const cfg = createConfig([{ pattern: 'git *', action: PermissionAction.Allow }], PermissionAction.Deny);
            const system = new PermissionSystem(cfg);

            expect(system.check('git add .', '/unknown').action).toBe(PermissionAction.Allow);
            expect(system.check('ls', '/unknown').action).toBe(PermissionAction.Deny);
        });

        it('keeps global behavior when no workspace root is provided', () => {
            const cfg = createConfig([{ pattern: 'git *', action: PermissionAction.Allow }], PermissionAction.Deny);
            cfg.workspacePermissions.set('/ws/a', {
                defaultPermission: PermissionAction.Deny,
                permissionRules: [{ pattern: 'git *', action: PermissionAction.Deny }]
            });
            const system = new PermissionSystem(cfg);

            expect(system.check('git add .').action).toBe(PermissionAction.Allow);
        });

        it('applies per-workspace rules within composed commands', () => {
            const cfg = createConfig([{ pattern: 'echo *', action: PermissionAction.Allow }], PermissionAction.Deny);
            cfg.workspacePermissions.set('/ws/a', {
                defaultPermission: PermissionAction.Allow,
                permissionRules: [{ pattern: 'rm *', action: PermissionAction.Deny }]
            });
            const system = new PermissionSystem(cfg);

            expect(system.check('echo hi && rm file.txt', '/ws/a').action).toBe(
                PermissionAction.Deny
            );
            expect(system.check('echo hi && echo there', '/ws/a').action).toBe(
                PermissionAction.Allow
            );
        });
    });

    describe('write-access tier', () => {
        it('allows a write rule in a writable workspace', () => {
            const system = new PermissionSystem(
                createConfig(
                    [{ pattern: 'git push *', action: PermissionAction.Allow, access: PermissionAccess.Write }]
                ),
                () => true
            );
            const result = system.check('git push origin main', '/ws/a');
            expect(result.action).toBe(PermissionAction.Allow);
            expect(result.denyReason).toBeUndefined();
        });

        it('denies a write rule in a read-only workspace with a write-access reason', () => {
            const system = new PermissionSystem(
                createConfig(
                    [{ pattern: 'git push *', action: PermissionAction.Allow, access: PermissionAccess.Write }]
                ),
                () => false
            );
            const result = system.check('git push origin main', '/ws/a');
            expect(result.action).toBe(PermissionAction.Deny);
            expect(result.denyReason).toBe(PermissionDenyReason.WriteAccess);
        });

        it('does not apply write gating when no canWrite predicate is provided', () => {
            const system = new PermissionSystem(
                createConfig([
                    { pattern: 'git push *', action: PermissionAction.Allow, access: PermissionAccess.Write }
                ])
            );
            expect(system.check('git push origin main', '/ws/a').action).toBe(
                PermissionAction.Allow
            );
        });

        it('read-classified rules apply regardless of workspace access', () => {
            const system = new PermissionSystem(
                createConfig([{ pattern: 'git *', action: PermissionAction.Allow }]),
                () => false
            );
            expect(system.check('git log', '/ws/a').action).toBe(PermissionAction.Allow);
        });

        it('default access is read when access is omitted', () => {
            const system = new PermissionSystem(
                createConfig([{ pattern: 'git *', action: PermissionAction.Allow }]),
                () => false
            );
            expect(system.check('git log', '/ws/a').action).toBe(PermissionAction.Allow);
        });

        it('deny rules are not gated by write access', () => {
            const system = new PermissionSystem(
                createConfig([
                    { pattern: 'git push *', action: PermissionAction.Deny, access: PermissionAccess.Write }
                ]),
                () => false
            );
            const result = system.check('git push origin main', '/ws/a');
            expect(result.action).toBe(PermissionAction.Deny);
            expect(result.denyReason).toBe(PermissionDenyReason.Pattern);
        });

        it('a more specific write rule blocks even where a broader read rule matches', () => {
            const system = new PermissionSystem(
                createConfig([
                    { pattern: 'git *', action: PermissionAction.Allow },
                    { pattern: 'git push *', action: PermissionAction.Allow, access: PermissionAccess.Write }
                ]),
                () => false
            );
            const result = system.check('git push origin main', '/ws/a');
            expect(result.action).toBe(PermissionAction.Deny);
            expect(result.denyReason).toBe(PermissionDenyReason.WriteAccess);
            // Read-only commands still pass via the read rule
            expect(system.check('git log', '/ws/a').action).toBe(PermissionAction.Allow);
        });

        it('resolves write access against the provided workspace root', () => {
            const writableRoots = new Set(['/ws/write']);
            const system = new PermissionSystem(
                createConfig([
                    { pattern: 'git push *', action: PermissionAction.Allow, access: PermissionAccess.Write }
                ]),
                (root) => writableRoots.has(root)
            );
            expect(system.check('git push origin main', '/ws/write').action).toBe(
                PermissionAction.Allow
            );
            expect(system.check('git push origin main', '/ws/read').action).toBe(
                PermissionAction.Deny
            );
        });
    });
        it('denies a composed command when a write subcommand matches a read-only workspace', () => {
            const system = new PermissionSystem(
                createConfig([
                    { pattern: 'git log *', action: PermissionAction.Allow },
                    { pattern: 'git push *', action: PermissionAction.Allow, access: PermissionAccess.Write }
                ]),
                () => false
            );
            const result = system.check('git log --oneline && git push origin main', '/ws/a');
            expect(result.action).toBe(PermissionAction.Deny);
            expect(result.denyReason).toBe(PermissionDenyReason.WriteAccess);
            expect(result.subcommands).toEqual(['git log --oneline', 'git push origin main']);
        });

        it('allows a composed command when the write subcommand runs in a writable workspace', () => {
            const system = new PermissionSystem(
                createConfig([
                    { pattern: 'git log *', action: PermissionAction.Allow },
                    { pattern: 'git push *', action: PermissionAction.Allow, access: PermissionAccess.Write }
                ]),
                () => true
            );
            expect(system.check('git log --oneline && git push origin main', '/ws/a').action).toBe(
                PermissionAction.Allow
            );
        });

        it('does not gate the default permission by workspace access', () => {
            const system = new PermissionSystem(
                createConfig([], PermissionAction.Allow),
                () => false
            );
            expect(system.check('echo hi', '/ws/a').action).toBe(PermissionAction.Allow);
        });

        it('applies the write tier to per-workspace rules', () => {
            const cfg = createConfig([]);
            cfg.workspacePermissions.set('/ws/ro', {
                defaultPermission: PermissionAction.Deny,
                permissionRules: [
                    { pattern: 'git push *', action: PermissionAction.Allow, access: PermissionAccess.Write }
                ]
            });
            cfg.workspacePermissions.set('/ws/rw', {
                defaultPermission: PermissionAction.Deny,
                permissionRules: [
                    { pattern: 'git push *', action: PermissionAction.Allow, access: PermissionAccess.Write }
                ]
            });
            const system = new PermissionSystem(cfg, (root) => root === '/ws/rw');

            const ro = system.check('git push origin main', '/ws/ro');
            expect(ro.action).toBe(PermissionAction.Deny);
            expect(ro.denyReason).toBe(PermissionDenyReason.WriteAccess);

            expect(system.check('git push origin main', '/ws/rw').action).toBe(
                PermissionAction.Allow
            );
        });

});
