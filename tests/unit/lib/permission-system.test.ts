import { describe, it, expect } from 'vitest';
import { PermissionSystem } from '../../../src/lib/permission.js';
import {
    PermissionAction,
    PermissionAccess,
    PermissionDenyReason,
    PermissionType,
    RedirectMode
} from '../../../src/lib/types.js';
import { ShellConfiguration } from '../../../src/lib/config.js';

describe('PermissionSystem', () => {
    function createConfig(
        rules: { pattern: string; action: PermissionAction; access?: PermissionAccess }[],
        defaultAction = PermissionAction.Deny,
        pathRules: { pattern: string; action: PermissionAction; access?: PermissionAccess }[] = []
    ): ShellConfiguration {
        const cfg = new ShellConfiguration();
        cfg.permissionRules = [
            ...rules,
            ...pathRules.map((rule) => ({ ...rule, type: PermissionType.Redirect }))
        ];
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

    it('denies a redirect with no matching path rule even when the core is allowed', () => {
        const system = new PermissionSystem(
            createConfig([
                { pattern: 'echo *', action: PermissionAction.Allow },
                { pattern: 'rm *', action: PermissionAction.Deny }
            ])
        );
        const result = system.check('echo hello > /tmp/out');
        expect(result.action).toBe(PermissionAction.Deny);
        expect(result.denyReason).toBe(PermissionDenyReason.Pattern);
    });

    it('allows a redirect matching a write-class path rule in a writable workspace', () => {
        const system = new PermissionSystem(
            createConfig(
                [{ pattern: 'echo *', action: PermissionAction.Allow }],
                PermissionAction.Deny,
                [{ pattern: '/tmp/*', action: PermissionAction.Allow, access: PermissionAccess.Write }]
            ),
            () => true
        );
        expect(system.check('echo hello > /tmp/out').action).toBe(PermissionAction.Allow);
    });

    it('denies pipe + redirect when no path rule matches the target', () => {
        const system = new PermissionSystem(
            createConfig([
                { pattern: 'ls', action: PermissionAction.Allow },
                { pattern: 'grep *', action: PermissionAction.Allow }
            ])
        );
        expect(system.check('ls | grep foo > /tmp/out').action).toBe(PermissionAction.Deny);
    });

    it('allows a stderr redirect to a path allowed by a path rule', () => {
        const system = new PermissionSystem(
            createConfig(
                [{ pattern: 'ls', action: PermissionAction.Allow }],
                PermissionAction.Deny,
                [{ pattern: '/dev/null', action: PermissionAction.Allow, access: PermissionAccess.Write }]
            ),
            () => true
        );
        expect(system.check('ls 2>/dev/null').action).toBe(PermissionAction.Allow);
    });

    it('denies a stderr redirect to a path without a path rule', () => {
        const system = new PermissionSystem(
            createConfig([{ pattern: 'ls', action: PermissionAction.Allow }])
        );
        expect(system.check('ls 2>/dev/null').action).toBe(PermissionAction.Deny);
    });

    it('matches ? glob pattern', () => {
        const system = new PermissionSystem(
            createConfig([{ pattern: 'ls ?', action: PermissionAction.Allow }])
        );
        expect(system.check('ls a').action).toBe(PermissionAction.Allow);
        expect(system.check('ls ab').action).toBe(PermissionAction.Deny);
    });

    it('matches literal unquoted redirect targets', () => {
        const system = new PermissionSystem(
            createConfig(
                [{ pattern: 'echo *', action: PermissionAction.Allow }],
                PermissionAction.Deny,
                [{ pattern: 'file name', action: PermissionAction.Allow, access: PermissionAccess.Write }]
            ),
            () => true
        );
        expect(system.check('echo hello > "file name"').action).toBe(PermissionAction.Allow);
        expect(system.check("echo hello > 'file name'").action).toBe(PermissionAction.Allow);
    });

    it('matches quoted redirect targets with escaped chars literally', () => {
        const system = new PermissionSystem(
            createConfig(
                [{ pattern: 'echo *', action: PermissionAction.Allow }],
                PermissionAction.Deny,
                [{ pattern: 'file"name', action: PermissionAction.Allow, access: PermissionAccess.Write }]
            ),
            () => true
        );
        expect(system.check(String.raw`echo hello > "file\"name"`).action).toBe(
            PermissionAction.Allow
        );
    });

    describe('per-workspace resolution', () => {
        it('uses workspace rules when a workspace root is provided', () => {
            const cfg = createConfig([{ pattern: 'git *', action: PermissionAction.Allow }]);
            cfg.workspacePermissions.set('/ws/a', {
                defaultPermission: PermissionAction.Allow,
                permissionRules: [{ pattern: 'git *', action: PermissionAction.Deny }],
                defaultType: PermissionType.Command,
                defaultAccess: PermissionAccess.Read
            });
            const system = new PermissionSystem(cfg);

            expect(system.check('git add .', '/ws/a').action).toBe(PermissionAction.Deny);
            expect(system.check('echo hi', '/ws/a').action).toBe(PermissionAction.Allow);
        });

        it('uses workspace default permission for unmatched commands', () => {
            const cfg = createConfig([], PermissionAction.Deny);
            cfg.workspacePermissions.set('/ws/a', {
                defaultPermission: PermissionAction.Allow,
                permissionRules: [],
                defaultType: PermissionType.Command,
                defaultAccess: PermissionAccess.Read
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
                permissionRules: [{ pattern: 'git *', action: PermissionAction.Deny }],
                defaultType: PermissionType.Command,
                defaultAccess: PermissionAccess.Read
            });
            const system = new PermissionSystem(cfg);

            expect(system.check('git add .').action).toBe(PermissionAction.Allow);
        });

        it('applies per-workspace rules within composed commands', () => {
            const cfg = createConfig([{ pattern: 'echo *', action: PermissionAction.Allow }], PermissionAction.Deny);
            cfg.workspacePermissions.set('/ws/a', {
                defaultPermission: PermissionAction.Allow,
                permissionRules: [{ pattern: 'rm *', action: PermissionAction.Deny }],
                defaultType: PermissionType.Command,
                defaultAccess: PermissionAccess.Read
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
            ],
            defaultType: PermissionType.Command,
            defaultAccess: PermissionAccess.Read
        });
        cfg.workspacePermissions.set('/ws/rw', {
            defaultPermission: PermissionAction.Deny,
            permissionRules: [
                { pattern: 'git push *', action: PermissionAction.Allow, access: PermissionAccess.Write }
            ],
            defaultType: PermissionType.Command,
            defaultAccess: PermissionAccess.Read
        });
        const system = new PermissionSystem(cfg, (root) => root === '/ws/rw');

        const ro = system.check('git push origin main', '/ws/ro');
        expect(ro.action).toBe(PermissionAction.Deny);
        expect(ro.denyReason).toBe(PermissionDenyReason.WriteAccess);

        expect(system.check('git push origin main', '/ws/rw').action).toBe(
            PermissionAction.Allow
        );
    });

    describe('redirect path rules', () => {
        it('denies output redirects in a read-only workspace with a write-access reason', () => {
            const system = new PermissionSystem(
                createConfig(
                    [{ pattern: 'echo *', action: PermissionAction.Allow }],
                    PermissionAction.Deny,
                    [{ pattern: '/tmp/*', action: PermissionAction.Allow, access: PermissionAccess.Write }]
                ),
                () => false
            );
            const result = system.check('echo hi > /tmp/out', '/ws/a');
            expect(result.action).toBe(PermissionAction.Deny);
            expect(result.denyReason).toBe(PermissionDenyReason.WriteAccess);
        });

        it('allows input redirects with a read-class path rule', () => {
            const system = new PermissionSystem(
                createConfig(
                    [{ pattern: 'cat', action: PermissionAction.Allow }],
                    PermissionAction.Deny,
                    [{ pattern: 'data/**', action: PermissionAction.Allow }]
                )
            );
            expect(system.check('cat < data/in.txt', '/ws/a').action).toBe(PermissionAction.Allow);
        });

        it('denies input redirects when only a write-class path rule matches', () => {
            const system = new PermissionSystem(
                createConfig(
                    [{ pattern: 'cat', action: PermissionAction.Allow }],
                    PermissionAction.Deny,
                    [{ pattern: 'data/**', action: PermissionAction.Allow, access: PermissionAccess.Write }]
                )
            );
            const result = system.check('cat < data/in.txt', '/ws/a');
            expect(result.action).toBe(PermissionAction.Deny);
            expect(result.denyReason).toBe(PermissionDenyReason.Pattern);
        });

        it('denies output redirects when only a read-class path rule matches', () => {
            const system = new PermissionSystem(
                createConfig(
                    [{ pattern: 'echo *', action: PermissionAction.Allow }],
                    PermissionAction.Deny,
                    [{ pattern: 'out/**', action: PermissionAction.Allow }]
                ),
                () => true
            );
            expect(system.check('echo hi > out/file.txt', '/ws/a').action).toBe(
                PermissionAction.Deny
            );
        });

        it('denies a redirect matching a deny path rule', () => {
            const system = new PermissionSystem(
                createConfig(
                    [{ pattern: 'echo *', action: PermissionAction.Allow }],
                    PermissionAction.Deny,
                    [{ pattern: '/etc/*', action: PermissionAction.Deny }]
                ),
                () => true
            );
            expect(system.check('echo hi > /etc/passwd', '/ws/a').action).toBe(
                PermissionAction.Deny
            );
        });

        it('uses the most specific path rule', () => {
            const system = new PermissionSystem(
                createConfig(
                    [{ pattern: 'echo *', action: PermissionAction.Allow }],
                    PermissionAction.Deny,
                    [
                        { pattern: '/tmp/*', action: PermissionAction.Deny },
                        { pattern: '/tmp/ok*', action: PermissionAction.Allow, access: PermissionAccess.Write }
                    ]
                ),
                () => true
            );
            expect(system.check('echo hi > /tmp/okfile', '/ws/a').action).toBe(
                PermissionAction.Allow
            );
            expect(system.check('echo hi > /tmp/other', '/ws/a').action).toBe(PermissionAction.Deny);
        });

        it('falls back to global path rules when a workspace has no entry', () => {
            const cfg = createConfig(
                [{ pattern: 'echo *', action: PermissionAction.Allow }],
                PermissionAction.Deny,
                [{ pattern: '/tmp/*', action: PermissionAction.Allow, access: PermissionAccess.Write }]
            );
            const system = new PermissionSystem(cfg, () => true);
            expect(system.check('echo hi > /tmp/out', '/unknown').action).toBe(
                PermissionAction.Allow
            );
        });

        it('resolves path rules per workspace', () => {
            const cfg = createConfig([{ pattern: 'echo *', action: PermissionAction.Allow }]);
            cfg.workspacePermissions.set('/ws/tmp', {
                defaultPermission: PermissionAction.Deny,
                defaultType: PermissionType.Command,
                defaultAccess: PermissionAccess.Read,
                permissionRules: [
                    { pattern: 'echo *', action: PermissionAction.Allow },
                    {
                        pattern: '/tmp/*',
                        action: PermissionAction.Allow,
                        access: PermissionAccess.Write,
                        type: PermissionType.Redirect
                    }
                ]
            });
            const system = new PermissionSystem(cfg, () => true);
            expect(system.check('echo hi > /tmp/out', '/ws/tmp').action).toBe(PermissionAction.Allow);
            expect(system.check('echo hi > /tmp/out', '/ws/other').action).toBe(
                PermissionAction.Deny
            );
        });

        it('reports fragments in the result', () => {
            const system = new PermissionSystem(
                createConfig(
                    [{ pattern: 'echo *', action: PermissionAction.Allow }],
                    PermissionAction.Deny,
                    [{ pattern: '/tmp/*', action: PermissionAction.Allow, access: PermissionAccess.Write }]
                ),
                () => true
            );
            const result = system.check('echo hi > /tmp/out', '/ws/a');
            expect(result.fragments).toHaveLength(1);
            expect(result.fragments[0]).toMatchObject({ raw: 'echo hi > /tmp/out', core: 'echo hi' });
            expect(result.fragments[0]!.tokens).toEqual([
                { mode: RedirectMode.Output, target: '/tmp/out', raw: '> /tmp/out' }
            ]);
            expect(result.subcommands).toEqual(['echo hi']);
        });

        it('checks redirect-only fragments with no command core', () => {
            const system = new PermissionSystem(
                createConfig(
                    [{ pattern: 'echo *', action: PermissionAction.Allow }],
                    PermissionAction.Deny,
                    [{ pattern: '/tmp/*', action: PermissionAction.Allow, access: PermissionAccess.Write }]
                ),
                () => true
            );
            expect(system.check('> /tmp/out').action).toBe(PermissionAction.Allow);
            expect(system.check('> /etc/passwd').action).toBe(PermissionAction.Deny);
            const result = system.check('> /tmp/out');
            expect(result.subcommands).toEqual(['']);
            expect(result.fragments[0]).toMatchObject({ core: '', raw: '> /tmp/out' });
        });
    });

    describe('default rule type', () => {
        it('treats untyped rules as redirect rules when defaultType is redirect', () => {
            const cfg = createConfig([]);
            cfg.defaultType = PermissionType.Redirect;
            cfg.permissionRules = [
                { pattern: 'echo *', action: PermissionAction.Allow },
                { pattern: '/tmp/*', action: PermissionAction.Allow, access: PermissionAccess.Write }
            ];
            const system = new PermissionSystem(cfg, () => true);

            // The echo rule is a redirect rule now, so no command core matches
            expect(system.check('echo hi', '/ws/a').action).toBe(PermissionAction.Deny);
            expect(system.check('echo hi > /tmp/out', '/ws/a').action).toBe(PermissionAction.Deny);
            expect(system.check('> /tmp/out', '/ws/a').action).toBe(PermissionAction.Allow);
        });

        it('honors an explicit rule type over defaultType', () => {
            const cfg = createConfig([]);
            cfg.defaultType = PermissionType.Redirect;
            cfg.permissionRules = [
                { pattern: 'echo *', action: PermissionAction.Allow, type: PermissionType.Command }
            ];
            const system = new PermissionSystem(cfg);
            expect(system.check('echo hi').action).toBe(PermissionAction.Allow);
        });
    });

    describe('default access tier', () => {
        it('gates allow rules without explicit access when defaultAccess is write', () => {
            const cfg = createConfig([{ pattern: 'git push *', action: PermissionAction.Allow }]);
            cfg.defaultAccess = PermissionAccess.Write;
            const system = new PermissionSystem(cfg, () => false);
            const result = system.check('git push origin main', '/ws/a');
            expect(result.action).toBe(PermissionAction.Deny);
            expect(result.denyReason).toBe(PermissionDenyReason.WriteAccess);
        });

        it('applies defaultAccess to redirect rules without explicit access', () => {
            const cfg = createConfig(
                [{ pattern: 'echo *', action: PermissionAction.Allow }],
                PermissionAction.Deny,
                [{ pattern: '/tmp/*', action: PermissionAction.Allow }]
            );
            cfg.defaultAccess = PermissionAccess.Write;
            const system = new PermissionSystem(cfg, () => true);

            expect(system.check('echo hi > /tmp/out').action).toBe(PermissionAction.Allow);
            expect(system.check('echo hi < /tmp/in').action).toBe(PermissionAction.Deny);
        });
    });
});