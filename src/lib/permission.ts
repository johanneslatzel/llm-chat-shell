import { resolve, sep } from 'node:path';
import {
    PermissionAction,
    PermissionAccess,
    PermissionDenyReason,
    PermissionType,
    RedirectMode,
    type ParsedSubcommand,
    type PermissionRule,
    type RedirectToken,
    type WorkspacePermissions
} from './types.js';
import type { ShellConfiguration } from './config.js';
import { countLiterals, countWildcards, dominates, matchesPattern } from './glob.js';
import { parseSubcommands } from './redirect-parser.js';

/** Result of a permission check. */
export interface PermissionCheckResult {
    /** The overall action (allow or deny). */
    action: PermissionAction;
    /** The individual subcommand cores that were checked. */
    subcommands: string[];
    /** The parsed subcommand fragments, including the redirect tokens. */
    fragments: ParsedSubcommand[];
    /** Why the command was denied; present when `action` is deny. */
    denyReason?: PermissionDenyReason;
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
 * A rule's family is its effective type (`type` or the permissions'
 * `defaultType`): command rules match command cores, redirect rules match
 * redirect targets. The two families never cross — a target can never be
 * evaluated as a command and a command core can never be authorized by a
 * redirect rule. See docs/architecture.md for the full redirect model.
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
    private readonly canWrite: (workspaceRoot: string) => boolean;

    /**
     * @param config - Shell configuration providing per-workspace and global permission settings.
     * @param canWrite - Optional predicate reporting whether a workspace root grants write access.
     *                   When omitted, write-classified rules are always satisfiable (legacy behavior).
     */
    constructor(config: ShellConfiguration, canWrite?: (workspaceRoot: string) => boolean) {
        this.resolve = (workspaceRoot) => config.resolvePermissions(workspaceRoot);
        this.canWrite = canWrite ?? (() => true);
    }

    /**
     * Check if a command is allowed.
     *
     * Command cores are matched against command rules; redirect targets are
     * matched against redirect rules (family from each rule's effective type).
     * Each fragment's core is checked first, then each of its redirect tokens;
     * the first denial fails the whole command.
     *
     * @param command - Raw shell command (may contain compositions).
     * @param workspaceRoot - Optional resolved workspace root to resolve rules against.
     * @returns The permission check result with action and parsed subcommands.
     */
    check(command: string, workspaceRoot?: string): PermissionCheckResult {
        const root = workspaceRoot ?? '';
        const perms = this.resolve(root);
        const fragments = parseSubcommands(command);
        const subcommands = fragments.map((fragment) => fragment.core);

        if (fragments.length === 0) {
            return { action: PermissionAction.Deny, subcommands: [], fragments };
        }

        for (const fragment of fragments) {
            if (fragment.core.length > 0) {
                const coreResult = this.checkCore(fragment.core, perms, root);
                if (coreResult.action === PermissionAction.Deny) {
                    return this.denyResult(subcommands, fragments, coreResult.denyReason);
                }
            }

            for (const token of fragment.tokens) {
                const tokenResult = this.checkToken(token, perms, root);
                if (tokenResult.action === PermissionAction.Deny) {
                    return this.denyResult(subcommands, fragments, tokenResult.denyReason);
                }
            }
        }

        return { action: PermissionAction.Allow, subcommands, fragments };
    }

    private denyResult(
        subcommands: string[],
        fragments: ParsedSubcommand[],
        denyReason?: PermissionDenyReason
    ): PermissionCheckResult {
        return {
            action: PermissionAction.Deny,
            subcommands,
            fragments,
            ...(denyReason !== undefined ? { denyReason } : {})
        };
    }

    /**
     * Match a single command core against the command rules and return the
     * action of the most specific matching rule, or the default action when
     * no rule matches. A winning allow rule whose access level the workspace
     * cannot satisfy (a write rule in a read-only workspace) is denied with
     * reason `'write-access'`.
     */
    private checkCore(
        core: string,
        perms: WorkspacePermissions,
        workspaceRoot: string
    ): { action: PermissionAction; denyReason?: PermissionDenyReason } {
        const commandRules = perms.permissionRules.filter(
            (rule) => this.effectiveType(rule, perms) === PermissionType.Command
        );
        const best = this.pickMatchingRule(commandRules, core);
        if (best === undefined) return { action: perms.defaultPermission };
        return this.decide(best.rule, perms.defaultAccess, workspaceRoot);
    }

    /**
     * Match a single redirect token against the redirect rules.
     *
     * Redirects default to deny: a token with no matching redirect rule is
     * denied. A deny rule denies the token. An allow rule must additionally
     * satisfy the mode-to-tier binding — `output` tokens need a write-class
     * allow rule (gated by workspace writability), `input` tokens a read-class
     * allow rule.
     */
    private checkToken(
        token: RedirectToken,
        perms: WorkspacePermissions,
        workspaceRoot: string
    ): { action: PermissionAction; denyReason?: PermissionDenyReason } {
        const redirectRules = perms.permissionRules.filter(
            (rule) => this.effectiveType(rule, perms) === PermissionType.Redirect
        );
        const best = this.pickMatchingRule(redirectRules, token.target);
        if (best === undefined || best.rule.action === PermissionAction.Deny) {
            return { action: PermissionAction.Deny, denyReason: PermissionDenyReason.Pattern };
        }

        const required =
            token.mode === RedirectMode.Output ? PermissionAccess.Write : PermissionAccess.Read;
        const ruleAccess = best.rule.access ?? perms.defaultAccess;
        if (ruleAccess !== required) {
            return { action: PermissionAction.Deny, denyReason: PermissionDenyReason.Pattern };
        }

        if (required === PermissionAccess.Write && !this.canWrite(workspaceRoot)) {
            return { action: PermissionAction.Deny, denyReason: PermissionDenyReason.WriteAccess };
        }

        return { action: PermissionAction.Allow };
    }

    /** Effective type of a rule: its explicit type or the permissions' default type. */
    private effectiveType(rule: PermissionRule, perms: WorkspacePermissions): PermissionType {
        return rule.type ?? perms.defaultType;
    }

    /**
     * Find the most specific rule whose pattern matches `value`, or undefined
     * when no rule matches. See the class doc for the specificity criteria.
     */
    private pickMatchingRule<T extends PermissionRule>(
        rules: T[],
        value: string
    ): { rule: T; index: number } | undefined {
        const matching = rules
            .map((rule, index) => ({ rule, index }))
            .filter(({ rule }) => matchesPattern(value, rule.pattern));
        if (matching.length === 0) return undefined;
        if (matching.length === 1) return matching[0]!;
        return this.sortBySpecificity(matching)[0]!;
    }

    private sortBySpecificity<T extends PermissionRule>(
        matching: { rule: T; index: number }[]
    ): { rule: T; index: number }[] {
        return matching.sort((a, b) => {
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
    }

    /**
     * Apply a single winning rule to a subcommand. An allow rule requiring
     * write access (its explicit access or the default access) is denied when
     * the workspace root is not writable.
     */
    private decide(
        rule: { pattern: string; action: PermissionAction; access?: PermissionAccess },
        defaultAccess: PermissionAccess,
        workspaceRoot: string
    ): { action: PermissionAction; denyReason?: PermissionDenyReason } {
        if (
            rule.action === PermissionAction.Allow &&
            (rule.access ?? defaultAccess) === PermissionAccess.Write &&
            !this.canWrite(workspaceRoot)
        ) {
            return { action: PermissionAction.Deny, denyReason: PermissionDenyReason.WriteAccess };
        }
        return {
            action: rule.action,
            ...(rule.action === PermissionAction.Deny
                ? { denyReason: PermissionDenyReason.Pattern }
                : {})
        };
    }
}

export { parseSubcommands };
export type { ParsedSubcommand };
