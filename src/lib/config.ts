import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { envOptionalString, envInt } from './env.js';
import {
    PermissionAction,
    PermissionAccess,
    type PermissionRule,
    type ShellConfigFile,
    type WorkspacePermissions
} from './types.js';

const DEFAULT_CTRL_C_TIMEOUT = 30000;
const DEFAULT_SIGTERM_TIMEOUT = 5000;
const DEFAULT_KILL_TIMEOUT = 5000;
const DEFAULT_MAX_SESSIONS = 10;
const DEFAULT_SESSION_TIMEOUT = 3600000;
const DEFAULT_BACKGROUND_TIMEOUT = 3600000;
const DEFAULT_MAX_TIMEOUT = 3600000;

function parsePermissionAction(value: unknown, path: string): PermissionAction {
    if (value === PermissionAction.Allow || value === PermissionAction.Deny) {
        return value;
    }
    throw new Error(`${path} must be 'allow' or 'deny', got ${JSON.stringify(value)}`);
}

function parsePermissionAccess(value: unknown, path: string): PermissionAccess | undefined {
    if (value === undefined) return undefined;
    if (value === PermissionAccess.Read || value === PermissionAccess.Write) {
        return value;
    }
    throw new Error(`${path} must be 'read' or 'write', got ${JSON.stringify(value)}`);
}

function parsePermissionRules(value: unknown, path: string): PermissionRule[] {
    if (!Array.isArray(value)) {
        throw new Error(`${path} must be an array of permission rules`);
    }
    return value.map((rule, index) => {
        if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
            throw new Error(`${path}[${index}] must be an object with 'pattern' and 'action'`);
        }
        const { pattern, action, access } = rule as Record<string, unknown>;
        if (typeof pattern !== 'string') {
            throw new Error(`${path}[${index}].pattern must be a string`);
        }
        const parsedAction = parsePermissionAction(action, `${path}[${index}].action`);
        const parsedAccess = parsePermissionAccess(access, `${path}[${index}].access`);
        return parsedAccess === undefined
            ? { pattern, action: parsedAction }
            : { pattern, action: parsedAction, access: parsedAccess };
    });
}

function parseWorkspacePermissionsEntry(value: unknown, path: string): WorkspacePermissions {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${path} must be an object with 'defaultPermission' and 'permissionRules'`);
    }
    const entryObject = value as Record<string, unknown>;
    return {
        defaultPermission: parsePermissionAction(
            entryObject.defaultPermission,
            `${path}.defaultPermission`
        ),
        permissionRules: parsePermissionRules(
            entryObject.permissionRules,
            `${path}.permissionRules`
        )
    };
}

function parseWorkspacePermissions(
    value: unknown,
    path: string
): Record<string, WorkspacePermissions> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${path} must be an object keyed by workspace root`);
    }
    const result: Record<string, WorkspacePermissions> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        result[key] = parseWorkspacePermissionsEntry(entry, `${path}.${key}`);
    }
    return result;
}

/**
 * Load and validate a shell permission config file (strict JSON).
 *
 * The file may contain `globalPermissions` and `workspacePermissions`. Any
 * structural or type error throws, so a typo'd or malformed file never
 * silently falls back to permissive defaults.
 *
 * @param configFilePath - Path to the JSON config file (resolved against the cwd).
 * @returns The parsed config file contents.
 * @throws When the file cannot be read, is not valid JSON, or has an invalid shape.
 */
export function loadShellConfigFile(configFilePath: string): ShellConfigFile {
    const resolved = resolve(configFilePath);
    let raw: string;
    try {
        raw = readFileSync(resolved, 'utf8');
    } catch (error) {
        throw new Error(
            `Cannot read shell config file '${configFilePath}': ${(error as Error).message}`,
            { cause: error }
        );
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(
            `Invalid JSON in shell config file '${configFilePath}': ${(error as Error).message}`,
            { cause: error }
        );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Shell config file '${configFilePath}' must contain a JSON object`);
    }

    const root = parsed as Record<string, unknown>;
    const result: ShellConfigFile = {};

    if (root.globalPermissions !== undefined) {
        result.globalPermissions = parseWorkspacePermissionsEntry(
            root.globalPermissions,
            'globalPermissions'
        );
    }
    if (root.workspacePermissions !== undefined) {
        result.workspacePermissions = parseWorkspacePermissions(
            root.workspacePermissions,
            'workspacePermissions'
        );
    }

    return result;
}

/** Configuration for {@link ShellPackage}. Reads timeouts and sessions from env vars; permission settings load from a config file (env: LLM_CHAT_SHELL_CONFIG). */
export class ShellConfiguration {
    /** Path to the permission config file (env: LLM_CHAT_SHELL_CONFIG). */
    readonly configFilePath: string | undefined = envOptionalString('LLM_CHAT_SHELL_CONFIG');

    /** Parsed contents of the config file ({} when no file is configured). */
    private readonly configFile: ShellConfigFile = (() => {
        if (this.configFilePath === undefined) return {};
        return loadShellConfigFile(this.configFilePath);
    })();

    /** Ms to wait after Ctrl+C before escalating to SIGTERM (env: LLM_CHAT_SHELL_CTRL_C_TIMEOUT, default: 30000). */
    ctrlCTimeout: number = (() => {
        const n = envInt('LLM_CHAT_SHELL_CTRL_C_TIMEOUT');
        return n !== undefined && n > 0 ? n : DEFAULT_CTRL_C_TIMEOUT;
    })();

    /** Ms to wait after SIGTERM before escalating to SIGKILL (env: LLM_CHAT_SHELL_SIGTERM_TIMEOUT, default: 5000). */
    sigtermTimeout: number = (() => {
        const n = envInt('LLM_CHAT_SHELL_SIGTERM_TIMEOUT');
        return n !== undefined && n > 0 ? n : DEFAULT_SIGTERM_TIMEOUT;
    })();

    /** Ms to wait after SIGKILL before giving up (env: LLM_CHAT_SHELL_KILL_TIMEOUT, default: 5000). */
    killTimeout: number = (() => {
        const n = envInt('LLM_CHAT_SHELL_KILL_TIMEOUT');
        return n !== undefined && n > 0 ? n : DEFAULT_KILL_TIMEOUT;
    })();

    /**
     * Max concurrent sessions (env: LLM_CHAT_SHELL_MAX_SESSIONS, default: 10).
     */
    maxSessions: number = (() => {
        const n = envInt('LLM_CHAT_SHELL_MAX_SESSIONS');
        return n !== undefined && n > 0 ? n : DEFAULT_MAX_SESSIONS;
    })();

    /** Session idle timeout in ms (env: LLM_CHAT_SHELL_SESSION_TIMEOUT, default: 3600000 = 1h). */
    sessionTimeout: number = (() => {
        const n = envInt('LLM_CHAT_SHELL_SESSION_TIMEOUT');
        return n !== undefined && n > 0 ? n : DEFAULT_SESSION_TIMEOUT;
    })();

    /**
     * Idle timeout in ms for background jobs that do not specify a `timeout`
     * (env: LLM_CHAT_SHELL_BACKGROUND_TIMEOUT, default: 3600000 = 1h).
     * Background commands only need to stay "chatty" for this long, so
     * long-running silent jobs are not killed by the short foreground
     * {@link ctrlCTimeout}.
     */
    backgroundTimeout: number = (() => {
        const n = envInt('LLM_CHAT_SHELL_BACKGROUND_TIMEOUT');
        return n !== undefined && n > 0 ? n : DEFAULT_BACKGROUND_TIMEOUT;
    })();

    /**
     * Upper bound in ms for LLM-supplied `timeout` values on the shell command
     * tool (env: LLM_CHAT_SHELL_MAX_TIMEOUT, default: 3600000 = 1h). Larger
     * requested timeouts are capped to this value. `0` disables the cap.
     */
    maxTimeout: number = (() => {
        const n = envInt('LLM_CHAT_SHELL_MAX_TIMEOUT');
        return n !== undefined && n >= 0 ? n : DEFAULT_MAX_TIMEOUT;
    })();

    /** Default permission for unmatched commands (config file: `globalPermissions.defaultPermission`, default: Deny). */
    defaultPermission: PermissionAction =
        this.configFile.globalPermissions?.defaultPermission ?? PermissionAction.Deny;

    /** Global permission rules (config file: `globalPermissions.permissionRules`). */
    permissionRules: PermissionRule[] = this.configFile.globalPermissions?.permissionRules ?? [];

    /**
     * Per-workspace permission settings keyed by resolved workspace root path
     * (config file: `workspacePermissions` — an object mapping each workspace
     * root to `{ defaultPermission, permissionRules }`).
     * Programmatic assignments take precedence over the config file.
     */
    workspacePermissions: Map<string, WorkspacePermissions> = (() => {
        const map = new Map<string, WorkspacePermissions>();
        if (this.configFile.workspacePermissions === undefined) return map;
        for (const [key, value] of Object.entries(this.configFile.workspacePermissions)) {
            map.set(resolve(key), value);
        }
        return map;
    })();

    /**
     * Resolve the effective permission settings for a workspace root.
     * Falls back to the global {@link defaultPermission} / {@link permissionRules}
     * when the root has no per-workspace entry.
     *
     * @param workspaceRoot - Resolved workspace root path ('' or undefined uses the global settings).
     */
    resolvePermissions(workspaceRoot: string): WorkspacePermissions {
        const found = this.workspacePermissions.get(resolve(workspaceRoot));
        if (found !== undefined) return found;
        return { defaultPermission: this.defaultPermission, permissionRules: this.permissionRules };
    }

    /**
     * Resolve the effective idle timeout for a command execution.
     *
     * A positive `requested` value (the LLM-supplied `timeout` param) wins and
     * is capped at {@link maxTimeout} when the cap is enabled. Otherwise the
     * value falls back to {@link backgroundTimeout} for background jobs and
     * {@link ctrlCTimeout} for foreground commands.
     *
     * @param background - True for background jobs.
     * @param requested - Optional LLM-supplied timeout in ms.
     * @returns The effective idle timeout in ms (> 0).
     */
    resolveIdleTimeout(background: boolean, requested?: number): number {
        if (requested !== undefined && requested > 0) {
            if (this.maxTimeout > 0 && requested > this.maxTimeout) {
                return this.maxTimeout;
            }
            return requested;
        }
        return background ? this.backgroundTimeout : this.ctrlCTimeout;
    }
}
