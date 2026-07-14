import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface, type Interface } from 'node:readline';
import type { ShellExecutor, ShellCommandResult, ShellExecuteOptions } from './types.js';
import type { ShellExecutorFactory } from './session-manager.js';

/** Minimal process-level config consumed by the bash executor (cwd and timeouts). */
export interface BashProcessConfig {
    /** Working directory the bash process starts in. Defaults to the process cwd. */
    cwd?: string;
    /** Ms of inactivity (no stdout/stderr output) before Ctrl+C is sent to a command (idle window). */
    ctrlCTimeout: number;
    /** Ms to wait after SIGTERM before escalating to SIGKILL. */
    sigtermTimeout: number;
    /** Ms to wait after SIGKILL before giving up. */
    killTimeout: number;
}

/** UUID v4 source pattern (no anchors) for matching sentinels. */
const UUID_V4_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

/**
 * Sentinel protocol for detecting command completion and capturing exit codes.
 * Generates a unique sentinel, listens for it in stdout, and resolves with the exit code.
 */
class SentinelProtocol {
    private _resolve: ((exitCode: number) => void) | null = null;
    private readonly _uuid = randomUUID();
    private readonly _sentinel = `__SHELL_SENTINEL_${this._uuid}_$?__`;

    get sentinel(): string {
        return this._sentinel;
    }

    /**
     * Start listening for the sentinel in readline output.
     * @param readline - The readline interface to listen on
     * @param outputLines - Array to collect non-sentinel output lines
     * @param timeoutStarted - Function that returns true if timeout escalation is in progress
     * @returns Promise that resolves with the exit code when sentinel is found
     */
    start(
        readline: Interface,
        outputLines: string[],
        timeoutStarted: () => boolean
    ): Promise<number> {
        const onData = (line: string) => {
            const match = line.match(new RegExp(`^__SHELL_SENTINEL_(${UUID_V4_SOURCE})_(\\d+)__$`));
            if (match !== null && match[1] === this._uuid) {
                // Found our sentinel — command is done. Extract exit code and resolve,
                // but only if no timeout is in progress (timeoutPromise takes precedence).
                if (!timeoutStarted()) {
                    const exitCode = parseInt(match[2]!, 10);
                    readline.removeListener('line', onData);
                    this._resolve!(exitCode);
                    this._resolve = null;
                }
            } else {
                // Regular output line — collect it.
                outputLines.push(line);
            }
        };

        readline.on('line', onData);

        return new Promise<number>((resolve) => {
            this._resolve = resolve;
        });
    }

    /** Resolve from exit handler (when process dies before sentinel arrives). */
    resolve(exitCode: number): void {
        if (this._resolve !== null) {
            const resolve = this._resolve;
            this._resolve = null;
            resolve(exitCode);
        }
    }
}

/**
 * Three-phase timeout escalation: Ctrl+C → SIGTERM → SIGKILL.
 *
 * The first phase is an **idle** window: the Ctrl+C timer resets on every
 * stdout/stderr activity, so a command that keeps producing output never
 * times out. Once the window expires the phase chain commits and is no
 * longer resettable.
 */
export class TimeoutEscalation {
    private _timedOut = false;
    private _sessionAlive = true;
    private idleTimer: NodeJS.Timeout | null = null;
    private resolveCurrent: ((code: number) => void) | null = null;

    get timedOut(): boolean {
        return this._timedOut;
    }

    get sessionAlive(): boolean {
        return this._sessionAlive;
    }

    constructor(
        private readonly proc: ChildProcess,
        private readonly config: BashProcessConfig,
        private readonly state: { timeoutStarted: boolean; killPhase: boolean }
    ) {}

    /** Start the idle-window countdown. Resolves with -1 after all phases complete. */
    start(): Promise<number> {
        return new Promise((resolve) => {
            this.resolveCurrent = resolve;
            this.armIdleTimer();
        });
    }

    /**
     * Report command activity (stdout/stderr output). Resets the idle window
     * as long as escalation has not committed. No-op once Ctrl+C was sent.
     */
    activity(): void {
        if (this.state.timeoutStarted) {
            return;
        }
        if (this.idleTimer !== null) {
            clearTimeout(this.idleTimer);
            this.armIdleTimer();
        }
    }

    /** Clear a still-pending idle window (command completed before it expired). */
    dispose(): void {
        if (this.idleTimer !== null) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        this.resolveCurrent = null;
    }

    /**
     * Handle expiry of the idle window: escalate unless the pending command is
     * already gone. Called by the idle timer; safe to invoke after dispose.
     */
    handleIdleExpiry(): void {
        this.idleTimer = null;
        const resolve = this.resolveCurrent;
        if (resolve !== null) {
            this.phaseCtrlC(resolve);
        }
    }

    private armIdleTimer(): void {
        this.idleTimer = setTimeout(() => this.handleIdleExpiry(), this.config.ctrlCTimeout);
    }

    private phaseCtrlC(resolve: (code: number) => void): void {
        this.state.timeoutStarted = true;
        this.proc.stdin!.write('\x03');
        setTimeout(() => this.phaseSigterm(resolve), this.config.sigtermTimeout);
    }

    private phaseSigterm(resolve: (code: number) => void): void {
        this.proc.kill('SIGTERM');
        setTimeout(() => this.phaseSigkill(resolve), this.config.killTimeout);
    }

    private phaseSigkill(resolve: (code: number) => void): void {
        this.state.killPhase = true;
        this.proc.kill('SIGKILL');
        this._sessionAlive = false;
        this._timedOut = true;
        resolve(-1);
    }
}

/**
 * Implementation of {@link ShellExecutor} that spawns a single persistent
 * bash process and communicates via stdin/stdout with sentinel markers.
 * One instance = one session.
 */
export class BashShellExecutor implements ShellExecutor {
    private proc: ChildProcess;
    private readline: Interface;
    private stderrBuffer = '';
    private processExitCode: number | null = null;
    private sentinel: SentinelProtocol | null = null;
    private closed = false;
    private readonly timeoutState = { killPhase: false, timeoutStarted: false };

    /**
     * @param config - Bash process configuration (cwd, timeouts).
     */
    constructor(private readonly config: BashProcessConfig) {
        this.proc = spawn('bash', ['--norc', '--noprofile'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: this.config.cwd
        });

        this.readline = createInterface({ input: this.proc.stdout! });

        this.proc.stderr!.on('data', (data: Buffer) => {
            this.stderrBuffer += data.toString();
        });

        this.proc.on('exit', (code) => {
            this.processExitCode = code ?? 1;
            if (this.timeoutState.killPhase || this.timeoutState.timeoutStarted) {
                // Don't resolve from exit handler during timeout escalation —
                // TimeoutEscalation will resolve.
                return;
            }
            // Resolve sentinel if process dies before sentinel arrives.
            this.sentinel?.resolve(this.processExitCode);
        });
    }

    /**
     * Execute a command in the persistent bash session.
     *
     * Uses a **sentinel protocol** to detect command completion and capture the exit code.
     * The problem: bash stdout is a raw byte stream with no "end of output" marker,
     * and the exit code (`$?`) only exists inside bash's memory. The sentinel solves both:
     *
     * 1. Node.js generates a unique sentinel string with a UUID and literal `$?`
     * 2. Node.js writes to bash stdin: the command, then `echo "<sentinel>"`
     * 3. Bash executes both: runs the command, then echoes the sentinel with `$?` expanded
     * 4. Node.js listener parses stdout, matches the sentinel by UUID, extracts exit code
     *
     * Example flow for `execute('ls -lah')`:
     * ```
     * Node.js stdin →  ls -lah
     * Node.js stdin →  echo "__SHELL_SENTINEL_a1b2c3_-_$?__"
     *
     * Bash stdout  →  file1.txt
     * Bash stdout  →  dir1/
     * Bash stdout  →  __SHELL_SENTINEL_a1b2c3_-0__       ← $? expanded to 0
     * ```
     */
    async execute(command: string, options?: ShellExecuteOptions): Promise<ShellCommandResult> {
        this.stderrBuffer = '';
        this.timeoutState.killPhase = false;
        this.timeoutState.timeoutStarted = false;

        // The idle limit for this execution: a positive explicit option wins,
        // otherwise the configured ctrlCTimeout applies.
        const requestedTimeout = options?.idleTimeoutMs;
        const idleTimeoutMs =
            requestedTimeout !== undefined && requestedTimeout > 0
                ? requestedTimeout
                : this.config.ctrlCTimeout;

        // Step 1: Set up sentinel protocol for command completion detection.
        this.sentinel = new SentinelProtocol();
        const outputLines: string[] = [];
        const sentinelPromise = this.sentinel.start(
            this.readline,
            outputLines,
            () => this.timeoutState.timeoutStarted
        );

        // Step 2: Send command to bash, then send echo with sentinel.
        // Bash will execute them sequentially: run the command, then echo the sentinel.
        // When bash echoes it, `$?` is expanded to the command's exit code.
        this.proc.stdin!.write(`${command}\n`);
        this.proc.stdin!.write(`echo "${this.sentinel.sentinel}"\n`);

        // Step 3: Idle-based timeout escalation (Ctrl+C → SIGTERM → SIGKILL).
        // The countdown resets on any stdout/stderr output; only silence triggers it.
        const escalation = new TimeoutEscalation(
            this.proc,
            { ...this.config, ctrlCTimeout: idleTimeoutMs },
            this.timeoutState
        );
        const onLine = () => escalation.activity();
        const onStderrData = () => escalation.activity();
        this.readline.on('line', onLine);
        this.proc.stderr!.on('data', onStderrData);
        const timeoutPromise = escalation.start();

        let exitCode: number;
        try {
            exitCode = await Promise.race([sentinelPromise, timeoutPromise]);

            // Give the event loop a chance to deliver any pending stderr data before
            // reading it, so the captured stderr is not truncated by the async read.
            await new Promise<void>((resolve) => setImmediate(resolve));
        } finally {
            this.readline.removeListener('line', onLine);
            this.proc.stderr!.removeListener('data', onStderrData);
            escalation.dispose();
        }

        // Step 4: Return collected output. The sentinel line was never added to
        // outputLines (it was caught by the if-branch), so it's excluded from output.
        const stdout = outputLines.join('\n').trimEnd();
        const stderr = this.stderrBuffer.trimEnd();

        const result: ShellCommandResult = {
            stdout,
            stderr,
            exitCode: escalation.timedOut ? -1 : exitCode,
            timedOut: escalation.timedOut,
            sessionAlive: escalation.sessionAlive
        };
        if (escalation.timedOut) {
            result.idleTimeoutMs = idleTimeoutMs;
        }

        return result;
    }

    /** @inheritdoc */
    async close(): Promise<void> {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.readline.close();

        if (this.proc.exitCode !== null) {
            return;
        }

        if (this.proc.stdin && !this.proc.stdin.destroyed) {
            this.proc.stdin.on('error', () => {});
            this.proc.stdin.write('exit\n');
        }

        this.proc.kill('SIGTERM');
    }

    /** @inheritdoc */
    isAlive(): boolean {
        return !this.timeoutState.killPhase && this.proc.exitCode === null;
    }
}

/**
 * Factory for creating {@link BashShellExecutor} instances.
 * Merges an optional per-session `cwd` with a shared process-level configuration.
 *
 * @example
 * ```typescript
 * const factory = new BashShellExecutorFactory(config);
 * const executor = await factory.create('/tmp'); // cwd override
 * const executor = await factory.create();       // uses config.cwd or process cwd
 * ```
 */
export class BashShellExecutorFactory implements ShellExecutorFactory {
    /**
     * @param config - Base bash process configuration shared across all sessions.
     */
    constructor(private readonly config: BashProcessConfig) {}

    /**
     * Create a new bash shell executor.
     * @param cwd - Optional working directory for this session, overriding `config.cwd`.
     */
    async create(cwd?: string): Promise<ShellExecutor> {
        return new BashShellExecutor(cwd ? { ...this.config, cwd } : this.config);
    }
}
