import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import {
    BashShellExecutor,
    BashShellExecutorFactory,
    TimeoutEscalation
} from '../../../src/lib/bash-executor.js';
import { ShellConfiguration } from '../../../src/lib/config.js';

describe('BashShellExecutor', () => {
    let executor: BashShellExecutor;

    afterEach(async () => {
        if (executor !== undefined) {
            await executor.close();
        }
    });

    it('executes a command and returns output', async () => {
        executor = new BashShellExecutor(new ShellConfiguration());
        const result = await executor.execute('echo hello');
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe('hello');
    });

    it('returns non-zero exit code on failure', async () => {
        executor = new BashShellExecutor(new ShellConfiguration());
        const result = await executor.execute('exit 42');
        expect(result.exitCode).toBe(42);
    });

    it('captures stderr', async () => {
        executor = new BashShellExecutor(new ShellConfiguration());
        const result = await executor.execute('echo error >&2');
        expect(result.stderr).toBe('error');
    });

    it('persists environment variables across commands', async () => {
        executor = new BashShellExecutor(new ShellConfiguration());
        await executor.execute('export FOO=bar');
        const result = await executor.execute('echo $FOO');
        expect(result.stdout).toBe('bar');
    });

    it('persists working directory across commands', async () => {
        executor = new BashShellExecutor(new ShellConfiguration());
        await executor.execute('cd /tmp');
        const result = await executor.execute('pwd');
        expect(result.stdout).toBe('/tmp');
    });

    it('re-anchors into the cwd option before running the command', async () => {
        executor = new BashShellExecutor(new ShellConfiguration());
        const result = await executor.execute('pwd', { cwd: '/tmp' });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe('/tmp');
    });

    it('re-anchors into a cwd containing single quotes', async () => {
        const dir = '/tmp/it\'s a test';
        await fs.mkdirSync(dir, { recursive: true });
        try {
            executor = new BashShellExecutor(new ShellConfiguration());
            const result = await executor.execute('pwd', { cwd: dir });
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toBe(dir);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('handles multi-line output', async () => {
        executor = new BashShellExecutor(new ShellConfiguration());
        const result = await executor.execute('echo line1; echo line2');
        expect(result.stdout).toBe('line1\nline2');
    });

    it('handles command with pipes', async () => {
        executor = new BashShellExecutor(new ShellConfiguration());
        const result = await executor.execute('echo "hello world" | grep hello');
        expect(result.stdout).toBe('hello world');
    });

    it('times out on slow commands', async () => {
        const cfg = new ShellConfiguration();
        cfg.ctrlCTimeout = 100;
        cfg.sigtermTimeout = 100;
        cfg.killTimeout = 100;
        executor = new BashShellExecutor(cfg);
        const result = await executor.execute('sleep 10');
        expect(result.exitCode).toBe(-1);
        expect(result.timedOut).toBe(true);
        expect(result.sessionAlive).toBe(false);
    });

    it('times out when command finishes after timeout starts but before SIGTERM', async () => {
        const cfg = new ShellConfiguration();
        cfg.ctrlCTimeout = 100;
        cfg.sigtermTimeout = 300;
        cfg.killTimeout = 100;
        executor = new BashShellExecutor(cfg);
        // sleep 0.3 finishes after Ctrl+C phase (100ms) but before SIGTERM (400ms)
        const result = await executor.execute('sleep 0.3 && echo done');
        expect(result.exitCode).toBe(-1);
        expect(result.timedOut).toBe(true);
        expect(result.sessionAlive).toBe(false);
    });

    it('sets timedOut=false and sessionAlive=true for normal commands', async () => {
        executor = new BashShellExecutor(new ShellConfiguration());
        const result = await executor.execute('echo hello');
        expect(result.exitCode).toBe(0);
        expect(result.timedOut).toBe(false);
        expect(result.sessionAlive).toBe(true);
    });

    it('does not time out a command that keeps producing output', async () => {
        const cfg = new ShellConfiguration();
        cfg.ctrlCTimeout = 300;
        cfg.sigtermTimeout = 100;
        cfg.killTimeout = 100;
        executor = new BashShellExecutor(cfg);
        // Total run ~0.5s across 5 ticks; each echo resets the 300ms idle window.
        const result = await executor.execute('for i in $(seq 1 5); do echo tick; sleep 0.1; done');
        expect(result.exitCode).toBe(0);
        expect(result.timedOut).toBe(false);
        expect(result.sessionAlive).toBe(true);
        expect(result.stdout).toContain('tick');
    });

    it('sets idleTimeoutMs on timeout results', async () => {
        const cfg = new ShellConfiguration();
        cfg.ctrlCTimeout = 100;
        cfg.sigtermTimeout = 100;
        cfg.killTimeout = 100;
        executor = new BashShellExecutor(cfg);
        const result = await executor.execute('sleep 10');
        expect(result.timedOut).toBe(true);
        expect(result.idleTimeoutMs).toBe(100);
    });

    it('omits idleTimeoutMs on normal results', async () => {
        executor = new BashShellExecutor(new ShellConfiguration());
        const result = await executor.execute('echo hello');
        expect(result.idleTimeoutMs).toBeUndefined();
    });

    it('overrides the idle timeout via execute options', async () => {
        const cfg = new ShellConfiguration();
        cfg.ctrlCTimeout = 100;
        cfg.sigtermTimeout = 100;
        cfg.killTimeout = 100;
        executor = new BashShellExecutor(cfg);
        // sleep 0.3 is silent for longer than the configured 100ms window,
        // but the explicit 10s option keeps it alive.
        const result = await executor.execute('sleep 0.3 && echo done', { idleTimeoutMs: 10000 });
        expect(result.exitCode).toBe(0);
        expect(result.timedOut).toBe(false);
        expect(result.sessionAlive).toBe(true);
        expect(result.stdout).toBe('done');
    });

    it('falls back to the configured timeout for a zero option', async () => {
        const cfg = new ShellConfiguration();
        cfg.ctrlCTimeout = 100;
        cfg.sigtermTimeout = 100;
        cfg.killTimeout = 100;
        executor = new BashShellExecutor(cfg);
        // A zero option no longer disables the limit; the 100ms idle window applies.
        const result = await executor.execute('sleep 2 && echo done', { idleTimeoutMs: 0 });
        expect(result.timedOut).toBe(true);
        expect(result.exitCode).toBe(-1);
        expect(result.idleTimeoutMs).toBe(100);
    });

    it('reports aliveness for a live and a killed process', async () => {
        const cfg = new ShellConfiguration();
        cfg.ctrlCTimeout = 100;
        cfg.sigtermTimeout = 100;
        cfg.killTimeout = 100;
        executor = new BashShellExecutor(cfg);
        expect(executor.isAlive()).toBe(true);
        await executor.execute('sleep 10');
        expect(executor.isAlive()).toBe(false);
    });

    it('reports not alive after the shell process exits', async () => {
        executor = new BashShellExecutor(new ShellConfiguration());
        const result = await executor.execute('exit');
        expect(result.exitCode).toBe(0);
        expect(executor.isAlive()).toBe(false);
    });

    it('factory create without cwd uses the process cwd', async () => {
        const factory = new BashShellExecutorFactory(new ShellConfiguration());
        const exec = await factory.create();
        const result = await exec.execute('pwd');
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe(process.cwd());
        await exec.close();
    });

    it('factory create with cwd overrides the configured cwd', async () => {
        const factory = new BashShellExecutorFactory(new ShellConfiguration());
        const exec = await factory.create('/tmp');
        const result = await exec.execute('pwd');
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe('/tmp');
        await exec.close();
    });

    it('is idempotent when closed twice', async () => {
        executor = new BashShellExecutor(new ShellConfiguration());
        await executor.execute('echo hello');
        await executor.close();
        await executor.close();
    });

    it('swallows a broken-pipe error when closing with a closed stdin', async () => {
        executor = new BashShellExecutor(new ShellConfiguration());
        const running = executor.execute('exec 0<&-; sleep 2 >/dev/null 2>&1');
        await new Promise((resolve) => setTimeout(resolve, 100));
        await executor.close();
        await running;
    });
});

describe('TimeoutEscalation', () => {
    it('does not reset the idle window after the escalation is disposed', () => {
        const cfg = new ShellConfiguration();
        cfg.ctrlCTimeout = 100;
        const proc = spawn('bash', ['--norc', '--noprofile'], { stdio: ['pipe', 'pipe', 'pipe'] });
        const esc = new TimeoutEscalation(proc, cfg, { timeoutStarted: false, killPhase: false });
        void esc.start();
        esc.dispose();
        expect(() => esc.activity()).not.toThrow();
        expect(esc.timedOut).toBe(false);
        proc.kill('SIGKILL');
    });

    it('ignores an idle-window expiry once the pending command is gone', () => {
        const cfg = new ShellConfiguration();
        cfg.ctrlCTimeout = 100;
        const proc = spawn('bash', ['--norc', '--noprofile'], { stdio: ['pipe', 'pipe', 'pipe'] });
        const esc = new TimeoutEscalation(proc, cfg, { timeoutStarted: false, killPhase: false });
        void esc.start();
        esc.dispose();
        esc.handleIdleExpiry();
        expect(esc.timedOut).toBe(false);
        proc.kill('SIGKILL');
    });
});
