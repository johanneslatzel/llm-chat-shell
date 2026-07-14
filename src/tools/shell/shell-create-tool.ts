import {
    Tool,
    ToolParameters,
    ToolParameterProperty,
    ResultStatus,
    type PartialToolResult
} from '@johannes.latzel/llm-chat';
import type { ShellSessionManager } from './session-manager.js';

/**
 * Tool that creates a new persistent shell session.
 * Returns a session ID that can be used with the shell_command tool.
 */
export class ShellCreateTool extends Tool {
    constructor(private sessionManager: ShellSessionManager) {
        super(
            'shell_create',
            'Creates a new persistent shell session. Returns a session ID for use with shell_command.',
            new ToolParameters({
                cwd: ToolParameterProperty.string(
                    'Working directory for this session. Must be within the configured working directory. ' +
                        'Relative paths are resolved against the configured cwd.'
                )
            })
        );
    }

    protected async onExecute(args: Record<string, unknown>): Promise<PartialToolResult> {
        const cwd = args['cwd'] as string | undefined;
        const sessionId = await this.sessionManager.createSession(cwd);
        return {
            result: sessionId,
            status: ResultStatus.Success
        };
    }
}
