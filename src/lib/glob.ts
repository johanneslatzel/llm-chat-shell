import picomatch from 'picomatch';

/** Check whether a string matches a glob pattern using picomatch. */
export function matchesPattern(str: string, pattern: string): boolean {
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
 *   `rm -rf` dominates `rm *`  — `rm *` matches the literal "rm -rf"
 *
 * @returns True if A is more concrete than B.
 */
export function dominates(a: string, b: string): boolean {
    if (countWildcards(a) > 0) return false;
    return matchesPattern(a, b);
}

/**
 * Count the number of wildcard characters (`*` and `?`) in a pattern.
 * Fewer wildcards means a more specific (concrete) pattern.
 */
export function countWildcards(pattern: string): number {
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
export function countLiterals(pattern: string): number {
    let count = 0;
    for (let i = 0; i < pattern.length; i++) {
        if (pattern[i] !== '*' && pattern[i] !== '?') count++;
    }
    return count;
}
