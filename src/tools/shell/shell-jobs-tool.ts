import {
    Tool,
    ToolParameters,
    ToolParameterProperty,
    ResultStatus,
    type PartialToolResult
} from '@johannes.latzel/llm-chat';
import type { ShellSessionManager } from './session-manager.js';

/**
 * Tool that lists the background jobs submitted to a session
 * (queued, running, completed, failed), oldest first.
 */
export class ShellJobsTool extends Tool {
    constructor(private sessionManager: ShellSessionManager) {
        super(
            'shell_jobs',
            'Lists the background jobs submitted to a session (queued, running, completed, failed), oldest first. Requires a session ID from shell_create.',
            new ToolParameters(
                {
                    sessionId: ToolParameterProperty.string('The session ID from shell_create.')
                },
                ['sessionId']
            )
        );
    }

    protected async onExecute(args: Record<string, unknown>): Promise<PartialToolResult> {
        this.validateRequiredParams(args, ['sessionId']);
        const sessionId = args['sessionId'] as string;
        const jobs = await this.sessionManager.listJobs(sessionId);
        if (jobs.length === 0) {
            return { result: `No jobs for session ${sessionId}.`, status: ResultStatus.Success };
        }
        const lines = jobs.map((job) => `${job.status}\t${job.id}\t${job.command}`);
        return {
            result: `${jobs.length} job(s) for session ${sessionId}:\n${lines.join('\n')}`,
            status: ResultStatus.Success
        };
    }
}
