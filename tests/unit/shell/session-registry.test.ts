import { describe, it, expect } from 'vitest';
import { Workspace, DirectoryConfiguration, AccessType } from '@johannes.latzel/llm-chat-workspace';
import { SessionRegistry } from '../../../src/tools/shell/session-registry.js';
import type { SessionEntry } from '../../../src/tools/shell/session-registry.js';
import { createJobRecord, JobRegistry } from '../../../src/tools/shell/job-registry.js';
import { ShellConfiguration } from '../../../src/tools/shell/config.js';
import type { ShellCommandResult, ShellExecutor, ShellExecutorFactory } from '../../../src/tools/shell/types.js';

class MockExecutor implements ShellExecutor {
    constructor(private readonly alive = true) {}
    async execute(): Promise<ShellCommandResult> {
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false, sessionAlive: true };
    }
    async close(): Promise<void> {}
    isAlive(): boolean {
        return this.alive;
    }
}

function createWorkspace(workspaceRoot: string): Workspace {
    return new Workspace(
        new DirectoryConfiguration(
            [{ type: AccessType.Write, path: workspaceRoot }],
            [],
            false,
            workspaceRoot
        )
    );
}

function createConfig(maxSessions = 10): ShellConfiguration {
    const cfg = new ShellConfiguration();
    cfg.maxSessions = maxSessions;
    return cfg;
}

function createFactory(executors?: ShellExecutor[]): ShellExecutorFactory & { created: ShellExecutor[] } {
    const queue = executors ?? [];
    const created: ShellExecutor[] = [];
    return {
        created,
        create: async () => {
            const exec = queue.shift() ?? new MockExecutor();
            created.push(exec);
            return exec;
        }
    };
}

function makeRegistry(maxSessions = 10) {
    const config = createConfig(maxSessions);
    const workspace = createWorkspace(process.cwd());
    const factory = createFactory();
    const jobs = new JobRegistry();
    const registry = new SessionRegistry(factory, config, workspace, jobs);
    return { registry, jobs, factory, workspace, config };
}

function queuedRecord(id: string, sessionId: string): ReturnType<typeof createJobRecord> {
    return createJobRecord({ id, sessionId, command: `cmd-${id}`, idleTimeoutMs: 30000 });
}

describe('SessionRegistry', () => {
    it('creates sessions bound to the workspace root and exposes entries', async () => {
        const { registry } = makeRegistry();
        expect(registry.entries()).toEqual([]);
        expect(registry.values()).toEqual([]);
        const id = await registry.create();
        expect(typeof id).toBe('string');
        expect(registry.get(id)).toBeDefined();
        expect(registry.has(id)).toBe(true);
        expect(registry.require(id)).toBe(registry.get(id));
        expect(registry.entries()).toHaveLength(1);
        expect(registry.values()).toHaveLength(1);
        expect(registry.getWorkspaceRoot(id)).toBe(process.cwd());
    });

    it('creates a session with an explicit cwd', async () => {
        const { registry } = makeRegistry();
        const id = await registry.create(process.cwd());
        expect(registry.getWorkspaceRoot(id)).toBe(process.cwd());
    });

    it('rejects a cwd outside the accessible directories', async () => {
        const { registry } = makeRegistry();
        await expect(registry.create('/outside-the-workspace')).rejects.toThrow(
            'cwd must be within the configured working directory'
        );
    });

    it('enforces maxSessions', async () => {
        const { registry } = makeRegistry(1);
        await registry.create();
        await expect(registry.create()).rejects.toThrow('Maximum sessions reached (1)');
    });

    it('rebinds a session to a different workspace root', async () => {
        const { registry } = makeRegistry();
        const id = await registry.create();
        registry.rebind(id, '/other-root');
        expect(registry.getWorkspaceRoot(id)).toBe('/other-root');
    });

    it('throws descriptive errors for unknown sessions', async () => {
        const { registry } = makeRegistry();
        expect(registry.get('nope')).toBeUndefined();
        expect(() => registry.require('nope')).toThrow('Session not found: nope');
        expect(() => registry.getWorkspaceRoot('nope')).toThrow('Session not found: nope');
        expect(() => registry.rebind('nope', '/x')).toThrow('Session not found: nope');
        expect(registry.remove('nope')).toBeUndefined();
        expect(registry.touch('nope')).toBeUndefined();
        expect(registry.dequeue('nope')).toBeUndefined();
        expect(registry.queuePosition('nope', 'x')).toBeUndefined();
    });

    it('removes and clears sessions', async () => {
        const { registry } = makeRegistry();
        const a = await registry.create();
        await registry.create();
        expect(registry.remove(a)).toBeDefined();
        expect(registry.has(a)).toBe(false);
        registry.clear();
        expect(registry.entries()).toHaveLength(0);
    });

    it('enqueues, positions, and dequeues jobs in FIFO order', async () => {
        const { registry } = makeRegistry();
        const id = await registry.create();
        const a = queuedRecord('a', id);
        const b = queuedRecord('b', id);

        expect(registry.enqueue(id, a)).toBe(true);
        expect(a.position).toBe(1);
        expect(registry.enqueue(id, b)).toBe(false);
        expect(b.position).toBe(2);

        expect(registry.queuePosition(id, 'a')).toBe(1);
        expect(registry.queuePosition(id, 'b')).toBe(2);
        expect(registry.queuePosition(id, 'zzz')).toBeUndefined();

        const first = registry.dequeue(id);
        expect(first?.job.id).toBe('a');
        expect(first?.entry).toBe(registry.get(id));
        expect(registry.queuePosition(id, 'a')).toBeUndefined();

        expect(registry.dequeue(id)?.job.id).toBe('b');
        expect(registry.dequeue(id)).toBeUndefined();
        expect(registry.get(id)?.processing).toBe(false);

        expect(() => registry.enqueue('nope', a)).toThrow('Session not found: nope');
    });

    it('touches session activity', async () => {
        const { registry } = makeRegistry();
        const id = await registry.create();
        const entry = registry.require(id);
        entry.lastUsedMs = 0;
        registry.touch(id);
        expect(entry.lastUsedMs).toBeGreaterThan(0);
    });

    it('takes the pending queue and can fail pending jobs', async () => {
        const { registry, jobs } = makeRegistry();
        const id = await registry.create();
        const entry = registry.require(id);
        const a = queuedRecord('a', id);
        const b = queuedRecord('b', id);
        registry.enqueue(id, a);
        registry.enqueue(id, b);
        jobs.set(a);
        jobs.set(b);

        const taken = registry.takeQueue(entry);
        expect(taken.map((j) => j.id)).toEqual(['a', 'b']);
        expect(entry.queue).toEqual([]);

        registry.enqueue(id, a);
        registry.enqueue(id, b);
        registry.failPending(entry, 'boom');
        expect(a.status).toBe('failed');
        expect(a.error).toBe('boom');
        expect(b.error).toBe('boom');
        expect(entry.queue).toEqual([]);
    });

    it('tears down a session: removes it, tombstones it, fails pending jobs', async () => {
        const { registry } = makeRegistry();
        const id = await registry.create();
        const pending = queuedRecord('p', id);
        registry.enqueue(id, pending);

        const executor = registry.teardown(id, 'closed', 'the session was closed before the job could run');
        expect(executor).toBeDefined();
        expect(registry.get(id)).toBeUndefined();
        expect(pending.status).toBe('failed');
        expect(pending.error).toBe('the session was closed before the job could run');
        expect(registry.notFoundMessage(id)).toContain('was closed');

        expect(registry.teardown(id, 'closed', 'x')).toBeUndefined();
    });

    it('only tears down when the entry still is the expected one', async () => {
        const { registry } = makeRegistry();
        const id = await registry.create();
        const real = registry.require(id);
        const fake: SessionEntry = {
            executor: new MockExecutor(),
            workspaceRoot: '',
            lastUsedMs: 0,
            queue: [],
            processing: false
        };
        expect(registry.teardown(id, 'closed', 'x', fake)).toBeUndefined();
        expect(registry.has(id)).toBe(true);

        expect(registry.teardown(id, 'closed', 'x', real)).toBe(real.executor);
        expect(registry.has(id)).toBe(false);
    });

    it('prunes dead sessions before creating, failing their pending jobs', async () => {
        const config = createConfig(1);
        const workspace = createWorkspace(process.cwd());
        const jobs = new JobRegistry();
        const dead = new MockExecutor(false);
        const live = new MockExecutor(true);
        const executors = [dead, live];
        const registry = new SessionRegistry(
            { create: async () => executors.shift()! },
            config,
            workspace,
            jobs
        );
        const deadId = await registry.create();
        const pending = queuedRecord('p', deadId);
        registry.enqueue(deadId, pending);
        jobs.set(pending);

        const liveId = await registry.create();
        expect(registry.get(deadId)).toBeUndefined();
        expect(pending.status).toBe('failed');
        expect(pending.error).toContain('process exited');
        expect(registry.notFoundMessage(deadId)).toContain('underlying shell process exited');
        expect(registry.get(liveId)).toBeDefined();
    });

    it('keeps live sessions when pruning', async () => {
        const { registry, factory } = makeRegistry();
        const id = await registry.create();
        const id2 = await registry.create();
        expect(factory.created).toHaveLength(2);
        expect(registry.get(id)).toBeDefined();
        expect(registry.get(id2)).toBeDefined();
    });

    it('expires only idle sessions with empty queues', async () => {
        const { registry } = makeRegistry();
        const idle = await registry.create();
        const busy = await registry.create();
        const withPending = await registry.create();
        const recent = await registry.create();

        registry.require(idle).lastUsedMs = 0;
        registry.require(busy).lastUsedMs = 0;
        registry.require(busy).processing = true;
        registry.require(withPending).lastUsedMs = 0;
        const pending = queuedRecord('q', withPending);
        registry.enqueue(withPending, pending);
        registry.require(withPending).processing = false;
        registry.require(recent).lastUsedMs = Date.now() + 100000;

        const now = Date.now() + 1000;
        const expired = registry.expired(now, 500);
        expect(expired.map(([id]) => id)).toEqual([idle]);
        expect(expired[0]![1]).toBe(registry.get(idle));
    });

    it('records tombstones with descriptive messages per reason', () => {
        const { registry } = makeRegistry();
        registry.recordDeath('s-timeout', 'timeout');
        expect(registry.notFoundMessage('s-timeout')).toContain(
            'was killed because a command produced no output for too long (idle limit: '
        );
        registry.recordDeath('s-expired', 'expired');
        expect(registry.notFoundMessage('s-expired')).toContain('expired after being idle for too long');
        registry.recordDeath('s-dead', 'process-exited');
        expect(registry.notFoundMessage('s-dead')).toContain('underlying shell process exited');
        registry.recordDeath('s-closed', 'closed');
        expect(registry.notFoundMessage('s-closed')).toContain('was closed');
        expect(registry.notFoundMessage('unknown')).toBe('Session not found: unknown');
    });

    it('evicts the oldest tombstones FIFO beyond the cap', () => {
        const { registry } = makeRegistry();
        for (let i = 0; i < 105; i++) {
            registry.recordDeath(`s${i}`, 'closed');
        }
        expect(registry.notFoundMessage('s0')).toBe('Session not found: s0');
        expect(registry.notFoundMessage('s4')).toBe('Session not found: s4');
        expect(registry.notFoundMessage('s5')).toContain('was closed');
    });
});
