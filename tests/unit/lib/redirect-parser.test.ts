import { describe, it, expect } from 'vitest';
import { parseSubcommands } from '../../../src/lib/redirect-parser.js';
import { RedirectMode } from '../../../src/lib/types.js';

describe('parseSubcommands', () => {
    describe('empty and simple', () => {
        it('returns empty array for empty string', () => {
            expect(parseSubcommands('')).toEqual([]);
        });

        it('returns empty array for whitespace-only', () => {
            expect(parseSubcommands('   ')).toEqual([]);
        });

        it('parses a single command', () => {
            expect(parseSubcommands('ls')).toEqual([{ raw: 'ls', core: 'ls', tokens: [] }]);
        });

        it('trims whitespace', () => {
            expect(parseSubcommands('  ls -la  ')).toEqual([
                { raw: 'ls -la', core: 'ls -la', tokens: [] }
            ]);
        });
    });

    describe('&& splitting', () => {
        it('splits on &&', () => {
            expect(parseSubcommands('cmd1 && cmd2')).toEqual([
                { raw: 'cmd1', core: 'cmd1', tokens: [] },
                { raw: 'cmd2', core: 'cmd2', tokens: [] }
            ]);
        });

        it('splits on multiple &&', () => {
            expect(parseSubcommands('cmd1 && cmd2 && cmd3')).toEqual([
                { raw: 'cmd1', core: 'cmd1', tokens: [] },
                { raw: 'cmd2', core: 'cmd2', tokens: [] },
                { raw: 'cmd3', core: 'cmd3', tokens: [] }
            ]);
        });

        it('skips empty fragments from leading or repeated operators', () => {
            expect(parseSubcommands('; echo hi')).toEqual([
                { raw: 'echo hi', core: 'echo hi', tokens: [] }
            ]);
            expect(parseSubcommands('a && && b')).toEqual([
                { raw: 'a', core: 'a', tokens: [] },
                { raw: 'b', core: 'b', tokens: [] }
            ]);
        });
    });

    describe('|| splitting', () => {
        it('splits on ||', () => {
            expect(parseSubcommands('cmd1 || cmd2')).toEqual([
                { raw: 'cmd1', core: 'cmd1', tokens: [] },
                { raw: 'cmd2', core: 'cmd2', tokens: [] }
            ]);
        });
    });

    describe('| splitting', () => {
        it('splits on |', () => {
            expect(parseSubcommands('ls -la | grep foo')).toEqual([
                { raw: 'ls -la', core: 'ls -la', tokens: [] },
                { raw: 'grep foo', core: 'grep foo', tokens: [] }
            ]);
        });
    });

    describe('; splitting', () => {
        it('splits on ;', () => {
            expect(parseSubcommands('cmd1; cmd2')).toEqual([
                { raw: 'cmd1', core: 'cmd1', tokens: [] },
                { raw: 'cmd2', core: 'cmd2', tokens: [] }
            ]);
        });

        it('handles ; with no space', () => {
            expect(parseSubcommands('cmd1;cmd2')).toEqual([
                { raw: 'cmd1', core: 'cmd1', tokens: [] },
                { raw: 'cmd2', core: 'cmd2', tokens: [] }
            ]);
        });
    });

    describe('mixed operators', () => {
        it('handles && and ||', () => {
            expect(parseSubcommands('cmd1 && cmd2 || cmd3')).toEqual([
                { raw: 'cmd1', core: 'cmd1', tokens: [] },
                { raw: 'cmd2', core: 'cmd2', tokens: [] },
                { raw: 'cmd3', core: 'cmd3', tokens: [] }
            ]);
        });

        it('handles all operators', () => {
            expect(parseSubcommands('cmd1 && cmd2 || cmd3; cmd4 | cmd5')).toEqual([
                { raw: 'cmd1', core: 'cmd1', tokens: [] },
                { raw: 'cmd2', core: 'cmd2', tokens: [] },
                { raw: 'cmd3', core: 'cmd3', tokens: [] },
                { raw: 'cmd4', core: 'cmd4', tokens: [] },
                { raw: 'cmd5', core: 'cmd5', tokens: [] }
            ]);
        });
    });

    describe('quoted strings', () => {
        it('does not split on operators inside double quotes', () => {
            expect(parseSubcommands('echo "hello && world"')).toEqual([
                { raw: 'echo "hello && world"', core: 'echo "hello && world"', tokens: [] }
            ]);
        });

        it('does not split on operators inside single quotes', () => {
            expect(parseSubcommands("echo 'hello || world'")).toEqual([
                { raw: "echo 'hello || world'", core: "echo 'hello || world'", tokens: [] }
            ]);
        });

        it('handles quoted operator then real operator', () => {
            expect(parseSubcommands('command1 --arg "&&" && command2')).toEqual([
                { raw: 'command1 --arg "&&"', core: 'command1 --arg "&&"', tokens: [] },
                { raw: 'command2', core: 'command2', tokens: [] }
            ]);
        });

        it('handles pipe inside quotes', () => {
            expect(parseSubcommands('echo "a | b" | grep a')).toEqual([
                { raw: 'echo "a | b"', core: 'echo "a | b"', tokens: [] },
                { raw: 'grep a', core: 'grep a', tokens: [] }
            ]);
        });

        it('handles semicolon inside quotes', () => {
            expect(parseSubcommands("echo 'a; b' && ls")).toEqual([
                { raw: "echo 'a; b'", core: "echo 'a; b'", tokens: [] },
                { raw: 'ls', core: 'ls', tokens: [] }
            ]);
        });
    });

    describe('escape sequences', () => {
        it('handles escaped double quote inside double quotes', () => {
            const input = String.raw`echo "foo\"bar" && ls`;
            expect(parseSubcommands(input)).toEqual([
                { raw: String.raw`echo "foo\"bar"`, core: String.raw`echo "foo\"bar"`, tokens: [] },
                { raw: 'ls', core: 'ls', tokens: [] }
            ]);
        });

        it('handles escaped single quote inside single quotes', () => {
            const input = String.raw`echo 'foo\'bar' && ls`;
            expect(parseSubcommands(input)).toEqual([
                { raw: String.raw`echo 'foo\'bar'`, core: String.raw`echo 'foo\'bar'`, tokens: [] },
                { raw: 'ls', core: 'ls', tokens: [] }
            ]);
        });

        it('handles different quote type inside current quote as literal', () => {
            expect(parseSubcommands('echo "don\'t"')).toEqual([
                { raw: 'echo "don\'t"', core: 'echo "don\'t"', tokens: [] }
            ]);
        });

        it('handles opposite quote nesting', () => {
            expect(parseSubcommands('echo \'he said "hi"\'')).toEqual([
                { raw: 'echo \'he said "hi"\'', core: 'echo \'he said "hi"\'', tokens: [] }
            ]);
        });
    });

    describe('adjacent chars around quotes', () => {
        it('accepts chars before opening quote', () => {
            expect(parseSubcommands('foo"bar" && ls')).toEqual([
                { raw: 'foo"bar"', core: 'foo"bar"', tokens: [] },
                { raw: 'ls', core: 'ls', tokens: [] }
            ]);
        });

        it('accepts chars after closing quote', () => {
            expect(parseSubcommands('"foo"bar && ls')).toEqual([
                { raw: '"foo"bar', core: '"foo"bar', tokens: [] },
                { raw: 'ls', core: 'ls', tokens: [] }
            ]);
        });
    });

    describe('redirect tokens', () => {
        it('keeps digit words that are not redirects', () => {
            expect(parseSubcommands('echo 42')).toEqual([
                { raw: 'echo 42', core: 'echo 42', tokens: [] }
            ]);
        });

        it('extracts a > target as an output token', () => {
            expect(parseSubcommands('cmd >out.txt')).toEqual([
                {
                    raw: 'cmd >out.txt',
                    core: 'cmd',
                    tokens: [{ mode: RedirectMode.Output, target: 'out.txt', raw: '>out.txt' }]
                }
            ]);
        });

        it('keeps the space between operator and target in raw', () => {
            expect(parseSubcommands('cmd > /tmp/out')).toEqual([
                {
                    raw: 'cmd > /tmp/out',
                    core: 'cmd',
                    tokens: [{ mode: RedirectMode.Output, target: '/tmp/out', raw: '> /tmp/out' }]
                }
            ]);
        });

        it('treats 2>&1 stderr-to-stdout redirect as an fd dup (no token)', () => {
            expect(parseSubcommands('cmd 2>&1')).toEqual([{ raw: 'cmd 2>&1', core: 'cmd', tokens: [] }]);
        });

        it('treats 1>&2 and >&- as fd dups (no token)', () => {
            expect(parseSubcommands('cmd 1>&2')).toEqual([{ raw: 'cmd 1>&2', core: 'cmd', tokens: [] }]);
            expect(parseSubcommands('cmd >&-')).toEqual([{ raw: 'cmd >&-', core: 'cmd', tokens: [] }]);
        });

        it('treats >& with a descriptor target as an fd dup (no token)', () => {
            expect(parseSubcommands('cmd >&1')).toEqual([{ raw: 'cmd >&1', core: 'cmd', tokens: [] }]);
        });

        it('treats <& with a descriptor target as an fd dup (no token)', () => {
            expect(parseSubcommands('cmd <&3')).toEqual([{ raw: 'cmd <&3', core: 'cmd', tokens: [] }]);
        });

        it('treats >& with a non-descriptor word as an output redirect to that file', () => {
            expect(parseSubcommands('cmd >& file.txt')).toEqual([
                {
                    raw: 'cmd >& file.txt',
                    core: 'cmd',
                    tokens: [{ mode: RedirectMode.Output, target: 'file.txt', raw: '>& file.txt' }]
                }
            ]);
        });

        it('extracts &> stdout+stderr redirect as output', () => {
            expect(parseSubcommands('cmd &>file.txt')).toEqual([
                {
                    raw: 'cmd &>file.txt',
                    core: 'cmd',
                    tokens: [{ mode: RedirectMode.Output, target: 'file.txt', raw: '&>file.txt' }]
                }
            ]);
        });

        it('extracts &>> as output', () => {
            expect(parseSubcommands('cmd &>>log')).toEqual([
                {
                    raw: 'cmd &>>log',
                    core: 'cmd',
                    tokens: [{ mode: RedirectMode.Output, target: 'log', raw: '&>>log' }]
                }
            ]);
        });

        it('extracts >> stdout append redirect as output', () => {
            expect(parseSubcommands('cmd >>file.txt')).toEqual([
                {
                    raw: 'cmd >>file.txt',
                    core: 'cmd',
                    tokens: [{ mode: RedirectMode.Output, target: 'file.txt', raw: '>>file.txt' }]
                }
            ]);
        });

        it('extracts 2>> stderr append redirect as output', () => {
            expect(parseSubcommands('cmd 2>>log.txt')).toEqual([
                {
                    raw: 'cmd 2>>log.txt',
                    core: 'cmd',
                    tokens: [{ mode: RedirectMode.Output, target: 'log.txt', raw: '2>>log.txt' }]
                }
            ]);
        });

        it('extracts < stdin redirect as input', () => {
            expect(parseSubcommands('cmd <input.txt')).toEqual([
                {
                    raw: 'cmd <input.txt',
                    core: 'cmd',
                    tokens: [{ mode: RedirectMode.Input, target: 'input.txt', raw: '<input.txt' }]
                }
            ]);
        });

        it('extracts a digit-fd input redirect', () => {
            expect(parseSubcommands('cmd 0<in.txt')).toEqual([
                {
                    raw: 'cmd 0<in.txt',
                    core: 'cmd',
                    tokens: [{ mode: RedirectMode.Input, target: 'in.txt', raw: '0<in.txt' }]
                }
            ]);
        });

        it('extracts <> as output', () => {
            expect(parseSubcommands('cmd <>state.db')).toEqual([
                {
                    raw: 'cmd <>state.db',
                    core: 'cmd',
                    tokens: [{ mode: RedirectMode.Output, target: 'state.db', raw: '<>state.db' }]
                }
            ]);
        });

        it('does not split a >| clobber redirect into a pipe', () => {
            expect(parseSubcommands('cmd >|out.txt')).toEqual([
                {
                    raw: 'cmd >|out.txt',
                    core: 'cmd',
                    tokens: [{ mode: RedirectMode.Output, target: 'out.txt', raw: '>|out.txt' }]
                }
            ]);
        });

        it('strips heredoc and here-string forms without a token', () => {
            expect(parseSubcommands('cat <<EOF')).toEqual([
                { raw: 'cat <<EOF', core: 'cat', tokens: [] }
            ]);
            expect(parseSubcommands('cat << "EOF"')).toEqual([
                { raw: 'cat << "EOF"', core: 'cat', tokens: [] }
            ]);
            expect(parseSubcommands('cat <<< hello')).toEqual([
                { raw: 'cat <<< hello', core: 'cat', tokens: [] }
            ]);
        });

        it('extracts &> with /dev/null target', () => {
            expect(parseSubcommands('cmd &>/dev/null')).toEqual([
                {
                    raw: 'cmd &>/dev/null',
                    core: 'cmd',
                    tokens: [{ mode: RedirectMode.Output, target: '/dev/null', raw: '&>/dev/null' }]
                }
            ]);
        });

        it('extracts multiple redirects in one subcommand', () => {
            expect(parseSubcommands('cmd >out 2>&1')).toEqual([
                {
                    raw: 'cmd >out 2>&1',
                    core: 'cmd',
                    tokens: [{ mode: RedirectMode.Output, target: 'out', raw: '>out' }]
                }
            ]);
        });

        it('extracts 2>&1 before > when 2>&1 comes first', () => {
            expect(parseSubcommands('cmd 2>&1 >out')).toEqual([
                {
                    raw: 'cmd 2>&1 >out',
                    core: 'cmd',
                    tokens: [{ mode: RedirectMode.Output, target: 'out', raw: '>out' }]
                }
            ]);
        });

        it('does not confuse 2>&1 with &>', () => {
            expect(parseSubcommands('cmd 2>&1 | grep foo')).toEqual([
                { raw: 'cmd 2>&1', core: 'cmd', tokens: [] },
                { raw: 'grep foo', core: 'grep foo', tokens: [] }
            ]);
        });

        it('handles redirects across piped commands', () => {
            expect(parseSubcommands('cmd >out | grep foo 2>&1')).toEqual([
                {
                    raw: 'cmd >out',
                    core: 'cmd',
                    tokens: [{ mode: RedirectMode.Output, target: 'out', raw: '>out' }]
                },
                { raw: 'grep foo 2>&1', core: 'grep foo', tokens: [] }
            ]);
        });

        it('extracts 2>/dev/null as output', () => {
            expect(parseSubcommands('echo hi 2>/dev/null')).toEqual([
                {
                    raw: 'echo hi 2>/dev/null',
                    core: 'echo hi',
                    tokens: [{ mode: RedirectMode.Output, target: '/dev/null', raw: '2>/dev/null' }]
                }
            ]);
        });

        it('unquotes a double-quoted target', () => {
            expect(parseSubcommands('cmd > "file name"')).toEqual([
                {
                    raw: 'cmd > "file name"',
                    core: 'cmd',
                    tokens: [{ mode: RedirectMode.Output, target: 'file name', raw: '> "file name"' }]
                }
            ]);
        });

        it('unquotes a single-quoted target', () => {
            expect(parseSubcommands("cmd > 'file name'")).toEqual([
                {
                    raw: "cmd > 'file name'",
                    core: 'cmd',
                    tokens: [
                        { mode: RedirectMode.Output, target: 'file name', raw: "> 'file name'" }
                    ]
                }
            ]);
        });

        it('unquotes escaped chars in a double-quoted target', () => {
            expect(parseSubcommands(String.raw`cmd > "file\"name"`)).toEqual([
                {
                    raw: String.raw`cmd > "file\"name"`,
                    core: 'cmd',
                    tokens: [
                        {
                            mode: RedirectMode.Output,
                            target: 'file"name',
                            raw: String.raw`> "file\"name"`
                        }
                    ]
                }
            ]);
        });

        it('does not treat a quoted redirect as an operator', () => {
            expect(parseSubcommands('echo ">" out')).toEqual([
                { raw: 'echo ">" out', core: 'echo ">" out', tokens: [] }
            ]);
        });

        it('treats an escaped > as a literal word char', () => {
            expect(parseSubcommands(String.raw`echo a\>b`)).toEqual([
                { raw: String.raw`echo a\>b`, core: String.raw`echo a\>b`, tokens: [] }
            ]);
        });

        it('treats a trailing backslash inside a quote as a literal', () => {
            const input = 'echo "abc' + '\\';
            expect(parseSubcommands(input)).toEqual([
                { raw: input, core: input, tokens: [] }
            ]);
        });

        it('unquotes an escaped space in a target', () => {
            expect(parseSubcommands(String.raw`cmd > my\ file`)).toEqual([
                {
                    raw: String.raw`cmd > my\ file`,
                    core: 'cmd',
                    tokens: [{ mode: RedirectMode.Output, target: 'my file', raw: String.raw`> my\ file` }]
                }
            ]);
        });

        it('stops a target at an unquoted &', () => {
            expect(parseSubcommands('cmd >out&x')).toEqual([
                {
                    raw: 'cmd >out&x',
                    core: 'cmd &x',
                    tokens: [{ mode: RedirectMode.Output, target: 'out', raw: '>out' }]
                }
            ]);
        });

        it('skips a redirect operator with no target', () => {
            expect(parseSubcommands('cmd > && echo hi')).toEqual([
                { raw: 'cmd >', core: 'cmd', tokens: [] },
                { raw: 'echo hi', core: 'echo hi', tokens: [] }
            ]);
        });

        it('skips a trailing >& with no target', () => {
            expect(parseSubcommands('cmd >&')).toEqual([{ raw: 'cmd >&', core: 'cmd', tokens: [] }]);
        });

        it('keeps redirect-only fragments', () => {
            expect(parseSubcommands('> /dev/null && echo hi')).toEqual([
                {
                    raw: '> /dev/null',
                    core: '',
                    tokens: [{ mode: RedirectMode.Output, target: '/dev/null', raw: '> /dev/null' }]
                },
                { raw: 'echo hi', core: 'echo hi', tokens: [] }
            ]);
        });

        it('keeps redirect-only fragments after ||, |, and ;', () => {
            expect(parseSubcommands('> /dev/null || echo a')).toEqual([
                {
                    raw: '> /dev/null',
                    core: '',
                    tokens: [{ mode: RedirectMode.Output, target: '/dev/null', raw: '> /dev/null' }]
                },
                { raw: 'echo a', core: 'echo a', tokens: [] }
            ]);
            expect(parseSubcommands('> /dev/null | echo a')).toEqual([
                {
                    raw: '> /dev/null',
                    core: '',
                    tokens: [{ mode: RedirectMode.Output, target: '/dev/null', raw: '> /dev/null' }]
                },
                { raw: 'echo a', core: 'echo a', tokens: [] }
            ]);
            expect(parseSubcommands('> /dev/null; echo a')).toEqual([
                {
                    raw: '> /dev/null',
                    core: '',
                    tokens: [{ mode: RedirectMode.Output, target: '/dev/null', raw: '> /dev/null' }]
                },
                { raw: 'echo a', core: 'echo a', tokens: [] }
            ]);
        });

        it('keeps an entirely redirect-only input', () => {
            expect(parseSubcommands('> /dev/null')).toEqual([
                {
                    raw: '> /dev/null',
                    core: '',
                    tokens: [{ mode: RedirectMode.Output, target: '/dev/null', raw: '> /dev/null' }]
                }
            ]);
        });

        it('strips the redirect from a command with a trailing target', () => {
            expect(parseSubcommands('echo hi > /dev/null')).toEqual([
                {
                    raw: 'echo hi > /dev/null',
                    core: 'echo hi',
                    tokens: [{ mode: RedirectMode.Output, target: '/dev/null', raw: '> /dev/null' }]
                }
            ]);
        });
    });
});