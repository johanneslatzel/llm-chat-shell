import { resolve, sep } from 'node:path';
import picomatch from 'picomatch';
import { PermissionAction, type WorkspacePermissions } from './types.js';
import type { ShellConfiguration } from './config.js';

/**
 * Split a shell command into individual subcommands by shell operators,
 * respecting quoted strings. Operators that trigger a split:
 * - `&&` (logical AND)
 * - `||` (logical OR)
 * - `|` (pipe)
 * - `;` (sequential)
 *
 * After splitting, shell redirects are stripped from each subcommand.
 *
 * @param input - Raw shell command string.
 * @returns Array of individual subcommands (with redirects stripped).
 */
export function parseSubcommands(input: string): string[] {
    const trimmed = input.trim();
    if (trimmed.length === 0) return [];

    const subcommands: string[] = [];
    let current = '';
    let inQuote: '"' | "'" | null = null;

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
                const sub = stripRedirects(current.trim());
                if (sub.length > 0) subcommands.push(sub);
                current = '';
                i += 1; // skip operator chars
                continue;
            }
        }

        // Check for 1-char operators (|, ;)
        if (ch === '|' || ch === ';') {
            const sub = stripRedirects(current.trim());
            if (sub.length > 0) subcommands.push(sub);
            current = '';
            continue;
        }

        current += ch;
    }

    // Flush remaining buffer
    const sub = stripRedirects(current.trim());
    if (sub.length > 0) subcommands.push(sub);

    return subcommands;
}

/**
 * Redirect operator patterns, ordered from longest to shortest to avoid
 * partial matches (e.g. `2>&1` before `2>`, `&>` before `>`).
 */
const REDIRECT_PATTERNS = [/&>/, /2>&1/, /2>>/, /2>/, />>/, /</, />/] as const;

/**
 * Skip past a redirect target after the operator has been matched.
 * Handles three target forms:
 * - `&N` — file descriptor target (e.g. `&1`)
 * - `"..."` / `'...'` — quoted filename
 * - unquoted word — bare filename or path
 *
 * @param target - The string immediately after the redirect operator.
 * @returns The remaining string after the target has been consumed.
 */
function skipRedirectTarget(target: string): string {
    if (target.length === 0) return '';

    const first = target[0]!;

    if (first === '&') {
        // File descriptor target like `&1` — skip `&` and any trailing digits
        let i = 1;
        while (i < target.length && /\d/.test(target[i]!)) i++;
        return target.substring(i);
    }

    if (first === '"' || first === "'") {
        // Quoted target — find matching close quote, respecting escapes
        let end = 1;
        while (end < target.length && target[end] !== first) {
            if (target[end] === '\\') end++;
            end++;
        }
        return target.substring(end + 1);
    }

    // Unquoted target — skip until whitespace
    let end = 0;
    while (end < target.length && /\S/.test(target[end]!)) end++;
    return target.substring(end);
}

/**
 * Strip shell redirect operators and their targets from a subcommand.
 * Redirects stripped: >, >>, <, 2>, 2>>, 2>&1, &>
 *
 * @param subcommand - A single subcommand string.
 * @returns The subcommand with redirects removed.
 */
function stripRedirects(subcommand: string): string {
    let result = subcommand;

    for (let changed = true; changed;) {
        changed = false;

        let earliest = -1;
        let earliestLen = 0;

        for (const pattern of REDIRECT_PATTERNS) {
            const match = result.match(pattern);
            if (match !== null && match.index !== undefined) {
                if (earliest === -1 || match.index < earliest) {
                    earliest = match.index;
                    earliestLen = match[0]!.length;
                }
            }
        }

        if (earliest === -1) break;

        const after = skipRedirectTarget(
            result.substring(earliest + earliestLen).replace(/^\s+/, '')
        );
        result = result.substring(0, earliest).trim() + after.trim();
        changed = true;
    }

    return result;
}

/** Check whether a string matches a glob pattern using picomatch. */
function matchesPattern(str: string, pattern: string): boolean {
    return picomatch.isMatch(str, pattern);
}

/**
 * Check whether pattern A "dominates" pattern B, meaning A is more concrete
 * (more specific) than B. This is the primary specificity criterion.
 *
 * A dominates B when A is a literal string (no wildcards) and B as a glob
 * pattern matches A. Intuitively: if B is broad enough to match the literal
 * text of A, then B is more general and A is more concrete.
 *
 * This check only applies when A has no wildcards. When both patterns contain
 * wildcards, the literal-match test can produce false positives (e.g. `ls ?`
 * matches the literal "ls *", but that doesn't make `ls *` more general).
 * In those cases, we fall through to wildcard count and literal character
 * count instead.
 *
 * Examples:
 *   `git push` dominates `git *`  — `git *` matches the literal "git push"
 *   `git push origin main` dominates `git push *`  — `git push *` matches "git push origin main"
 *   `rm -rf /tmp` dominates `rm *`  — `rm *` matches the literal "rm -rf /tmp"
 *
 * @returns True if A is more concrete than B.
 */
function dominates(a: string, b: string): boolean {
    if (countWildcards(a) > 0) return false;
    return matchesPattern(a, b);
}

/**
 * Count the number of wildcard characters (`*` and `?`) in a pattern.
 * Fewer wildcards means a more specific (concrete) pattern.
 */
function countWildcards(pattern: string): number {
    let count = 0;
    for (let i = 0; i < pattern.length; i++) {
        if (pattern[i] === '*' || pattern[i] === '?') count++;
    }
    return count;
}

/**
 * Count the number of literal (non-wildcard) characters in a pattern.
 * More literal characters means a more specific (concrete) pattern.
 */
function countLiterals(pattern: string): number {
    let count = 0;
    for (let i = 0; i < pattern.length; i++) {
        if (pattern[i] !== '*' && pattern[i] !== '?') count++;
    }
    return count;
}

/** Result of a permission check. */
export interface PermissionCheckResult {
    /** The overall action (allow or deny). */
    action: PermissionAction;
    /** The individual subcommands that were checked. */
    subcommands: string[];
}

/**
 * Whether `target` equals `root` or is located underneath it.
 * The prefix is `root + sep` so that `/ws/a` does not match a sibling like
 * `/ws/abc`. A root that is itself the filesystem root (`/`) needs no extra
 * separator, otherwise the prefix would wrongly become `//`.
 */
function isWithin(target: string, root: string): boolean {
    const prefix = root.endsWith(sep) ? root : root + sep;
    return target === root || target.startsWith(prefix);
}

/**
 * Find the deepest access root that contains `path`.
 *
 * A path is inside a root when it equals the root or lies under it. Roots are
 * resolved before comparison, so relative inputs (e.g. `src`) work too. Among
 * all roots that contain the path, the one with the longest path is the
 * deepest (most specific) match — e.g. `/ws/a/deep` wins over `/ws/a` for
 * `/ws/a/deep/file`, since containing roots are always strictly nested.
 *
 * Returns `''` when no root contains `path`; callers treat that as "no
 * workspace" and fall back to the global permission settings.
 *
 * @param path - Absolute or relative path to locate within the workspace.
 * @param accessRoots - Access root paths from `Workspace.getAccesses()`.
 * @returns The deepest containing access root, or `''` when outside every root.
 */
export function workspaceForPath(path: string, accessRoots: readonly string[]): string {
    const resolved = resolve(path);

    let deepest = '';
    for (const root of accessRoots) {
        const resolvedRoot = resolve(root);
        if (!isWithin(resolved, resolvedRoot)) continue;
        if (resolvedRoot.length > deepest.length) deepest = resolvedRoot;
    }
    return deepest;
}

/**
 * Permission system that parses composed shell commands into subcommands
 * and checks each against glob patterns.
 *
 * Rules are resolved per workspace: the check takes an optional workspace root
 * and uses its {@link WorkspacePermissions}. Without a workspace root, the global
 * fallback settings apply.
 *
 * When multiple rules match a subcommand, the most specific rule wins.
 * Specificity is determined by four criteria, applied in order:
 *
 * 1. **Dominance**: A literal pattern A dominates pattern B when B as a
 *    glob matches A as a literal string. Only applies when A has no wildcards,
 *    because wildcard-containing patterns can produce false positives.
 *    Example: `git push` dominates `git *` because `git *` matches "git push".
 *
 * 2. **Wildcard count**: Fewer wildcards (`*`, `?`) means more specific.
 *    Example: `git push` (0 wildcards) beats `git push *` (1 wildcard).
 *
 * 3. **Literal character count**: More literal characters means more specific.
 *    Example: `git push *` (9 literals) beats `git p*` (5 literals).
 *
 * 4. **First declared**: If criteria 1–3 don't differentiate, the rule
 *    appearing earlier in the configuration wins (stable ordering).
 */
export class PermissionSystem {
    private resolve: (workspaceRoot: string) => WorkspacePermissions;

    /**
     * @param config - Shell configuration providing per-workspace and global permission settings.
     */
    constructor(config: ShellConfiguration) {
        this.resolve = (workspaceRoot) => config.resolvePermissions(workspaceRoot);
    }

    /**
     * Check if a command is allowed.
     *
     * @param command - Raw shell command (may contain compositions).
     * @param workspaceRoot - Optional resolved workspace root to resolve rules against.
     * @returns The permission check result with action and parsed subcommands.
     */
    check(command: string, workspaceRoot?: string): PermissionCheckResult {
        const perms = this.resolve(workspaceRoot ?? '');
        const subcommands = parseSubcommands(command);

        if (subcommands.length === 0) {
            return { action: PermissionAction.Deny, subcommands: [] };
        }

        for (const sub of subcommands) {
            const action = this.checkSubcommand(sub, perms);
            if (action === PermissionAction.Deny) {
                return { action: PermissionAction.Deny, subcommands };
            }
        }

        return { action: PermissionAction.Allow, subcommands };
    }

    /**
     * Find the most specific matching rule for a subcommand.
     *
     * Collects all rules whose pattern matches the subcommand, then sorts
     * them by specificity (see class doc). Returns the action of the most
     * specific rule, or the default action if no rules match.
     */
    private checkSubcommand(subcommand: string, perms: WorkspacePermissions): PermissionAction {
        const matchingRules = perms.permissionRules
            .map((rule, index) => ({ rule, index }))
            .filter(({ rule }) => matchesPattern(subcommand, rule.pattern));

        if (matchingRules.length === 0) {
            return perms.defaultPermission;
        }

        if (matchingRules.length === 1) {
            return matchingRules[0]!.rule.action;
        }

        matchingRules.sort((a, b) => {
            const aDominates = dominates(a.rule.pattern, b.rule.pattern);
            const bDominates = dominates(b.rule.pattern, a.rule.pattern);

            if (aDominates && !bDominates) return -1;
            if (!aDominates && bDominates) return 1;

            const aWildcards = countWildcards(a.rule.pattern);
            const bWildcards = countWildcards(b.rule.pattern);
            if (aWildcards !== bWildcards) return aWildcards - bWildcards;

            const aLiterals = countLiterals(a.rule.pattern);
            const bLiterals = countLiterals(b.rule.pattern);
            if (aLiterals !== bLiterals) return bLiterals - aLiterals;

            return a.index - b.index;
        });

        return matchingRules[0]!.rule.action;
    }
}
