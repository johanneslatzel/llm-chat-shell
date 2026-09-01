import { describe, it, expect } from 'vitest';
import { parseSubcommands, workspaceForPath } from '../../../src/lib/permission.js';

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
