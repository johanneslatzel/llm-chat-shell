import { RedirectMode, type ParsedSubcommand, type RedirectToken } from './types.js';

/**
 * Whether a redirect operator targets a file that needs permission checking, or
 * is symbolic and never opens a file. Symbolic redirects reselect an existing
 * input/output source (another file descriptor, or script-supplied text) and
 * produce no redirect token.
 */
enum RedirectOpMode {
    /** The redirect writes to the target file (creating or truncating it). */
    FileOutput = 'file-output',
    /** The redirect reads from the target file. */
    FileInput = 'file-input',
    /** Symbolic output redirect: duplicates/closes an output descriptor, never a file. */
    SymbolicOutput = 'symbolic-output',
    /** Symbolic input redirect: input from a descriptor or script text, never a file. */
    SymbolicInput = 'symbolic-input'
}

/** True when an operator mode targets a file (FileOutput/FileInput). */
function isFileMode(mode: RedirectOpMode): boolean {
    return mode === RedirectOpMode.FileOutput || mode === RedirectOpMode.FileInput;
}

/**
 * Redirect operators, ordered longest-first so shorter operators cannot shadow
 * longer ones (`&>>` before `&>`, `>>`/`>|`/`>&` before `>`,
 * `<>`/`<&`/`<<<`/`<<` before `<`). fd-numbered operators are matched by a
 * digit run before the symbol (see {@link matchRedirectOp}). Each member is an
 * enum-like operator carrying its symbol and redirect mode; symbolic modes
 * never open a file (fd-dup/close, heredoc/here-string).
 */
const REDIRECT_OPS = {
    StdoutStderrAppend: { symbol: '&>>', mode: RedirectOpMode.FileOutput },
    StdoutStderr: { symbol: '&>', mode: RedirectOpMode.FileOutput },
    Append: { symbol: '>>', mode: RedirectOpMode.FileOutput },
    Clobber: { symbol: '>|', mode: RedirectOpMode.FileOutput },
    FdDupErr: { symbol: '>&', mode: RedirectOpMode.SymbolicOutput },
    ReadWrite: { symbol: '<>', mode: RedirectOpMode.FileOutput },
    FdDupIn: { symbol: '<&', mode: RedirectOpMode.SymbolicInput },
    HereString: { symbol: '<<<', mode: RedirectOpMode.SymbolicInput },
    HereDoc: { symbol: '<<', mode: RedirectOpMode.SymbolicInput },
    Stdout: { symbol: '>', mode: RedirectOpMode.FileOutput },
    Stdin: { symbol: '<', mode: RedirectOpMode.FileInput }
} as const;

/** The symbol text of a redirect operator (e.g. `'>>'`). */
type RedirectOpSymbol = (typeof REDIRECT_OPS)[keyof typeof REDIRECT_OPS]['symbol'];

/** A redirect operator matched at a position, including any fd digit prefix. */
interface MatchedRedirect {
    /** The operator symbol as written (without the fd digit prefix). */
    symbol: RedirectOpSymbol;
    /** The redirect mode: file modes produce a token, symbolic modes never touch a file. */
    mode: RedirectOpMode;
    /** Index just after the operator (including any fd digit prefix). */
    end: number;
}

/**
 * Whether an unquoted `&>` word names a real file (so it redirects stdout and
 * stderr to that file and needs a permission token). The `&>` operator is
 * ambiguous: when its word is a descriptor spec — one or more digits (`>&1`,
 * `>&10`) or the close marker `-` (`>&-`) — bash treats it as a descriptor
 * dup/close and opens no file; any other word is the target file. A missing
 * word (`&>` with nothing after) touches no file either.
 */
function redirectsToFile(
    op: MatchedRedirect,
    word: { target: string; end: number; hasTarget: boolean }
): boolean {
    return (
        op.symbol === '>&' && word.hasTarget && !/^\d+$/.test(word.target) && word.target !== '-'
    );
}

/**
 * Split a shell command into individual subcommands by shell operators,
 * respecting quoted strings. Operators that trigger a split:
 * - `&&` (logical AND)
 * - `||` (logical OR)
 * - `|` (pipe, except inside a `>|` redirect)
 * - `;` (sequential)
 *
 * Each subcommand keeps its raw text plus its extracted redirect tokens.
 * Redirect-only fragments (e.g. `> file`) are retained: they still create or
 * truncate the target file and must be permission-checked.
 *
 * @param input - Raw shell command string.
 * @returns The individual subcommand fragments with cores and redirect tokens.
 */
export function parseSubcommands(input: string): ParsedSubcommand[] {
    const trimmed = input.trim();
    if (trimmed.length === 0) return [];

    const fragments: string[] = [];
    let current = '';
    let inQuote: '"' | "'" | null = null;

    const flush = (): void => {
        const fragment = current.trim();
        if (fragment.length > 0) fragments.push(fragment);
        current = '';
    };

    for (let i = 0; i < trimmed.length; i++) {
        const ch = trimmed[i]!;

        // Handle escape sequences inside quotes
        if (inQuote !== null && ch === '\\' && i + 1 < trimmed.length) {
            current += ch + trimmed[i + 1]!;
            i++;
            continue;
        }

        // Handle quote toggling
        if (ch === '"' || ch === "'") {
            current += ch;
            if (inQuote === ch) {
                // Closing quote
                inQuote = null;
            } else if (inQuote === null) {
                // Opening quote
                inQuote = ch;
            }
            // Different quote type inside current quote — already added as literal
            continue;
        }

        // Skip processing operators if inside quotes
        if (inQuote !== null) {
            current += ch;
            continue;
        }

        // Check for 2-char operators (&&, ||)
        if (i + 1 < trimmed.length) {
            const two = trimmed.substring(i, i + 2);
            if (two === '&&' || two === '||') {
                flush();
                i += 1; // skip operator chars
                continue;
            }
        }

        // `>|` is the clobber redirect operator, not a pipe split
        if (ch === '|' && i > 0 && trimmed[i - 1] === '>') {
            current += ch;
            continue;
        }

        // Check for 1-char operators (|, ;)
        if (ch === '|' || ch === ';') {
            flush();
            continue;
        }

        current += ch;
    }

    // Flush remaining buffer
    flush();

    return fragments.map((raw) => {
        const { core, tokens } = parseRedirects(raw);
        return { raw, core, tokens };
    });
}

/**
 * Match a redirect operator at `start`. Redirects may carry an fd number
 * prefix (e.g. `2>`, `3>>`, `4<`), which is consumed as part of the operator —
 * bash treats the digit run directly before the operator as the fd number.
 * Returns null when no operator starts at `start` (plain word character).
 */
function matchRedirectOp(s: string, start: number): MatchedRedirect | null {
    let j = start;
    while (j < s.length && /\d/.test(s[j]!)) j++;
    const rest = s.substring(j);

    if (j > start) {
        for (const op of Object.values(REDIRECT_OPS)) {
            if (rest.startsWith(op.symbol)) {
                return { symbol: op.symbol, mode: op.mode, end: j + op.symbol.length };
            }
        }
        return null;
    }

    for (const op of Object.values(REDIRECT_OPS)) {
        if (s.startsWith(op.symbol, start)) {
            return { symbol: op.symbol, mode: op.mode, end: start + op.symbol.length };
        }
    }
    return null;
}

/** Whether a character is shell whitespace. */
function isShellWhitespace(ch: string | undefined): boolean {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/** Index of the first non-whitespace char at or after `start`. */
function skipWhitespace(s: string, start: number): number {
    let i = start;
    while (i < s.length && isShellWhitespace(s[i])) i++;
    return i;
}

/**
 * Read the word following a redirect operator, unquoting it as it goes.
 * Quotes concatenate with surrounding text (`/tmp/"my dir"/file`). The word
 * stops at shell whitespace or at an unquoted `<`, `>` or `&`.
 *
 * @returns The unquoted target and the index after the word. `hasTarget` is
 *          false when no word follows the operator.
 */
function readRedirectTarget(
    s: string,
    start: number
): { target: string; end: number; hasTarget: boolean } {
    let i = start;
    let target = '';
    let hasTarget = false;

    while (i < s.length) {
        const ch = s[i]!;
        if (isShellWhitespace(ch) || ch === '<' || ch === '>' || ch === '&') break;

        hasTarget = true;

        if (ch === '"' || ch === "'") {
            // Quoted segment — find the matching close quote, respecting escapes
            const quote = ch;
            i++;
            while (i < s.length && s[i] !== quote) {
                if (s[i] === '\\' && i + 1 < s.length) {
                    target += s[i + 1]!;
                    i += 2;
                    continue;
                }
                target += s[i]!;
                i++;
            }
            i++; // closing quote
            continue;
        }

        if (ch === '\\' && i + 1 < s.length) {
            target += s[i + 1]!;
            i += 2;
            continue;
        }

        target += ch;
        i++;
    }

    return { target, end: i, hasTarget };
}

/**
 * Extract redirects from a single subcommand fragment.
 *
 * File-expecting redirects (output and input forms) produce a redirect token;
 * the operator plus target is removed from the core. fd-dup/close operators
 * (`2>&1`, `<&N`, `>&-`) and heredocs/here-strings (`<<`, `<<<`) never touch a
 * file and are stripped without a token. `>& file` (non-descriptor word)
 * redirects stdout and stderr to the file and produces an output token.
 *
 * @param subcommand - A single subcommand fragment (trimmed).
 * @returns The fragment context plus the extracted redirect tokens.
 */
function parseRedirects(subcommand: string): { core: string; tokens: RedirectToken[] } {
    const tokens: RedirectToken[] = [];
    let core = '';
    let inQuote: '"' | "'" | null = null;

    for (let i = 0; i < subcommand.length; i++) {
        const ch = subcommand[i]!;

        // Handle escape sequences inside quotes
        if (inQuote !== null && ch === '\\' && i + 1 < subcommand.length) {
            core += ch + subcommand[i + 1]!;
            i++;
            continue;
        }

        // Handle quote toggling
        if (ch === '"' || ch === "'") {
            core += ch;
            if (inQuote === ch) {
                inQuote = null;
            } else if (inQuote === null) {
                inQuote = ch;
            }
            continue;
        }

        // Skip processing operators if inside quotes
        if (inQuote !== null) {
            core += ch;
            continue;
        }

        // An escaped `<` or `>` outside quotes is a literal word character
        if (
            ch === '\\' &&
            i + 1 < subcommand.length &&
            (subcommand[i + 1] === '<' || subcommand[i + 1] === '>')
        ) {
            core += ch + subcommand[i + 1]!;
            i++;
            continue;
        }

        const op = matchRedirectOp(subcommand, i);
        if (op === null) {
            core += ch;
            continue;
        }

        const wordStart = skipWhitespace(subcommand, op.end);
        const word = readRedirectTarget(subcommand, wordStart);
        if (isFileMode(op.mode)) {
            // File-expecting redirect: extract the (unquoted) target word
            if (word.hasTarget) {
                tokens.push({
                    mode:
                        op.mode === RedirectOpMode.FileOutput
                            ? RedirectMode.Output
                            : RedirectMode.Input,
                    target: word.target,
                    raw: subcommand.substring(i, word.end)
                });
            }
            // Resume at the char after the consumed segment (the loop re-advances)
            i = (word.hasTarget ? word.end : op.end) - 1;
            continue;
        }

        // fd-dup/close (`>&`, `<&`) and heredoc/here-string (`<<`, `<<<`):
        // no file access — strip the operator (and for `>& file` the word).
        if (redirectsToFile(op, word)) {
            // `>& file` redirects stdout and stderr to the file: an output token
            tokens.push({
                mode: RedirectMode.Output,
                target: word.target,
                raw: subcommand.substring(i, word.end)
            });
        }
        i = (word.hasTarget ? word.end : op.end) - 1;
    }

    return { core: core.trim(), tokens };
}

export type { ParsedSubcommand };
