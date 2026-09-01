import { describe, it, expect } from 'vitest';
import { PermissionSystem } from '../../../src/lib/permission.js';
import { PermissionAction } from '../../../src/lib/types.js';
import { ShellConfiguration } from '../../../src/lib/config.js';

describe('PermissionSystem', () => {
    function createConfig(
        rules: { pattern: string; action: PermissionAction }[],
        defaultAction = PermissionAction.Deny
    ): ShellConfiguration {
        const cfg = new ShellConfiguration();
        cfg.permissionRules = rules;
        cfg.defaultPermission = defaultAction;
        return cfg;
    }

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
});