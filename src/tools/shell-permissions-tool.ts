import {
    Tool,
    ToolParameters,
    ResultStatus,
    type PartialToolResult
} from '@johannes.latzel/llm-chat';
import type { Workspace } from '@johannes.latzel/llm-chat-workspace';
import type { ShellConfiguration } from '../lib/config.js';
import { workspaceForPath } from '../lib/permission.js';

/**
 * Tool that returns the current workspace and the permission rules / default
 * action that apply to it. Lets the LLM understand what commands are allowed or
 * denied in the active workspace before attempting them.
 */
export class ShellPermissionsTool extends Tool {
    constructor(
        private config: ShellConfiguration,
        private workspace: Workspace
    ) {
        super(
            'shell_permissions',
            'Returns the current workspace, its effective permission rules, and the default permission action. ' +
                'Use this to understand what shell commands are allowed or denied before executing them.',
            new ToolParameters({})
        );
    }

    protected async onExecute(): Promise<PartialToolResult> {
        const currentPath = this.workspace.currentPath;
        const roots = this.workspace.getAccesses().map((a) => a.path);
        const root = workspaceForPath(currentPath, roots) || currentPath;
        const perms = this.config.resolvePermissions(root);

        const parts: string[] = [`Workspace: ${currentPath}`];
        if (root !== currentPath) {
            parts.push(`Workspace root: ${root}`);
        }
        parts.push(`Default: ${perms.defaultPermission}`);

        if (perms.permissionRules.length > 0) {
            parts.push('Rules:');
            for (let i = 0; i < perms.permissionRules.length; i++) {
                const rule = perms.permissionRules[i]!;
                const access = rule.access !== undefined ? ` (${rule.access})` : '';
                parts.push(`${i + 1}. ${rule.pattern} → ${rule.action}${access}`);
            }
        }

        return { result: parts.join('\n'), status: ResultStatus.Success };
    }
}
