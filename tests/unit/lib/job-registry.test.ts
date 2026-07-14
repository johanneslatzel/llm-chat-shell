import { describe, it, expect } from 'vitest';
import { createJobRecord, JobRegistry } from '../../../src/lib/job-registry.js';
import { ShellJobStatus } from '../../../src/lib/types.js';
import type { ShellCommandResult } from '../../../src/lib/types.js';

const okResult: ShellCommandResult = {
    stdout: 'out',
    stderr: 'err',
    exitCode: 0,
    timedOut: false,
    sessionAlive: true
};

function makeRecord(id: string, sessionId = 's1'): ReturnType<typeof createJobRecord> {
    return createJobRecord({
        id,
        sessionId,
        cwd: '/work',
        command: `cmd-${id}`,
        idleTimeoutMs: 30000
    });
}

describe('createJobRecord', () => {
    it('builds a queued record with completion signalling', async () => {
        const record = makeRecord('j1');
        expect(record.id).toBe('j1');
        expect(record.sessionId).toBe('s1');
        expect(record.command).toBe('cmd-j1');
        expect(record.status).toBe(ShellJobStatus.Queued);
        expect(record.position).toBe(0);
        expect(record.idleTimeoutMs).toBe(30000);
        expect(typeof record.submittedAt).toBe('number');
        record.resolveDone();
        await expect(record.done).resolves.toBeUndefined();
    });
});

describe('JobRegistry', () => {
    it('gets and requires records', () => {
        const registry = new JobRegistry();
        const record = makeRecord('j1');
        expect(registry.get('j1')).toBeUndefined();
        expect(() => registry.require('j1')).toThrow('Job not found: j1');
        registry.set(record);
        expect(registry.get('j1')).toBe(record);
        expect(registry.require('j1')).toBe(record);
    });

    it('finish records the result and resolves done', async () => {
        const registry = new JobRegistry();
        const record = makeRecord('j1');
        registry.set(record);
        registry.finish(record, okResult);
        expect(record.status).toBe(ShellJobStatus.Completed);
        expect(record.stdout).toBe('out');
        expect(record.stderr).toBe('err');
        expect(record.exitCode).toBe(0);
        expect(record.timedOut).toBe(false);
        expect(record.sessionAlive).toBe(true);
        expect(record.finishedAt).toBeGreaterThan(0);
        await expect(record.done).resolves.toBeUndefined();
    });

    it('fail records the error and resolves done', async () => {
        const registry = new JobRegistry();
        const record = makeRecord('j1');
        registry.set(record);
        registry.fail(record, 'boom');
        expect(record.status).toBe(ShellJobStatus.Failed);
        expect(record.error).toBe('boom');
        expect(record.finishedAt).toBeGreaterThan(0);
        await expect(record.done).resolves.toBeUndefined();
    });

    it('failAll fails every record and tolerates an empty list', async () => {
        const registry = new JobRegistry();
        registry.failAll([], 'nothing to fail');
        const a = makeRecord('a');
        const b = makeRecord('b');
        registry.set(a);
        registry.set(b);
        registry.failAll([a, b], 'boom');
        expect(a.status).toBe(ShellJobStatus.Failed);
        expect(a.error).toBe('boom');
        expect(b.status).toBe(ShellJobStatus.Failed);
    });

    it('lists jobs per session and all jobs, oldest first', () => {
        const registry = new JobRegistry();
        expect(registry.listForSession('s1')).toEqual([]);
        expect(registry.listAll()).toEqual([]);
        const a = makeRecord('a', 's1');
        const b = makeRecord('b', 's2');
        const c = makeRecord('c', 's1');
        registry.set(a);
        registry.set(b);
        registry.set(c);
        expect(registry.listForSession('s1').map((j) => j.id)).toEqual(['a', 'c']);
        expect(registry.listForSession('s2').map((j) => j.id)).toEqual(['b']);
        expect(registry.listAll().map((j) => j.id)).toEqual(['a', 'b', 'c']);
    });

    it('returns snapshot copies, never the live records', () => {
        const registry = new JobRegistry();
        const record = makeRecord('a');
        registry.set(record);
        const snapshot = registry.listAll()[0]!;
        expect(snapshot).not.toBe(record);
        snapshot.status = ShellJobStatus.Completed;
        expect(record.status).toBe(ShellJobStatus.Queued);
    });

    it('evicts the oldest finished jobs beyond the cap', () => {
        const registry = new JobRegistry();
        for (let i = 0; i < 205; i++) {
            const record = makeRecord(`j${i}`);
            registry.set(record);
            registry.finish(record, okResult);
        }
        expect(registry.get('j0')).toBeUndefined();
        expect(registry.get('j4')).toBeUndefined();
        expect(registry.get('j5')).toBeDefined();
        expect(registry.listAll()).toHaveLength(200);
    });

    it('never evicts queued or running jobs', () => {
        const registry = new JobRegistry();
        const pending = makeRecord('pending');
        registry.set(pending);
        for (let i = 0; i < 200; i++) {
            const record = makeRecord(`j${i}`);
            registry.set(record);
            registry.finish(record, okResult);
        }
        expect(registry.get('pending')).toBeDefined();
        expect(pending.status).toBe(ShellJobStatus.Queued);
        expect(registry.listAll()).toHaveLength(200);
    });

    it('evicts what it can when pending jobs alone exceed the cap', () => {
        const registry = new JobRegistry();
        for (let i = 0; i < 205; i++) {
            registry.set(makeRecord(`p${i}`));
        }
        const done = makeRecord('done');
        registry.set(done);
        registry.finish(done, okResult);
        expect(registry.get('done')).toBeUndefined();
        expect(registry.listAll()).toHaveLength(205);
        expect(registry.get('p0')).toBeDefined();
    });
});
