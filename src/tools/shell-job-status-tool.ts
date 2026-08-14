import {
    Tool,
    ToolParameters,
    ToolParameterProperty,
    ResultStatus,
    type PartialToolResult
} from '@johannes.latzel/llm-chat';
import type { ShellSessionManager } from '../lib/session-manager.js';
import { ShellJobStatus } from '../lib/types.js';
import type { ShellJob } from '../lib/types.js';

/**
 * Tool that returns the status and, once finished, the results of a background
 * job submitted with `shell_command` and `background=true`.
 */
export class ShellJobStatusTool extends Tool {
    constructor(private sessionManager: ShellSessionManager) {
        super(
            'shell_job_status',
            'Returns the status and, once finished, the results (stdout, stderr, exit code) of a background job submitted with shell_command (background=true). Requires the jobId returned at submission.',
            new ToolParameters(
                {
                    jobId: ToolParameterProperty.string(
                        'The job ID returned by shell_command when background=true.'
                    )
                },
                ['jobId']
            )
        );
    }

    protected async onExecute(args: Record<string, unknown>): Promise<PartialToolResult> {
        this.validateRequiredParams(args, ['jobId']);
        const jobId = args['jobId'] as string;
        const job = await this.sessionManager.getJobStatus(jobId);
        return { result: this.formatJob(job), status: ResultStatus.Success };
    }

    private formatJob(job: ShellJob): string {
        const parts: string[] = [];
        parts.push(`jobId: ${job.id}`);
        parts.push(`session: ${job.sessionId}`);
        parts.push(`cwd: ${job.cwd}`);
        parts.push(`command: ${job.command}`);
        parts.push(`status: ${job.status}`);
        parts.push(`submitted: ${new Date(job.submittedAt).toISOString()}`);
        if (job.startedAt !== undefined) {
            parts.push(`started: ${new Date(job.startedAt).toISOString()}`);
        }
        if (job.finishedAt !== undefined) {
            parts.push(`finished: ${new Date(job.finishedAt).toISOString()}`);
        }
        parts.push(`idle timeout: ${job.idleTimeoutMs}ms`);
        if (job.status === ShellJobStatus.Queued) {
            parts.push(`queue position: ${job.position}`);
        }
        if (job.status === ShellJobStatus.Failed && job.error !== undefined) {
            parts.push(`error: ${job.error}`);
        }
        if (job.status === ShellJobStatus.Completed) {
            if (job.stdout !== undefined && job.stdout.length > 0) {
                parts.push(`stdout:\n${job.stdout}`);
            }
            if (job.stderr !== undefined && job.stderr.length > 0) {
                parts.push(`[stderr] ${job.stderr}`);
            }
            if (job.timedOut === true) {
                parts.push('[timed out]');
            }
            if (job.exitCode !== undefined && job.exitCode !== 0) {
                parts.push(`[exit code: ${job.exitCode}]`);
            }
        }
        return parts.join('\n');
    }
}
