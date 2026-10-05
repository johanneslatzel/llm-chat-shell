import { describe, it, expect } from 'vitest';
import { workspaceForPath } from '../../../src/lib/permission.js';

describe('workspaceForPath', () => {
    it('returns empty string when cwd is outside all access roots', () => {
        expect(workspaceForPath('/elsewhere', ['/ws/a', '/ws/b'])).toBe('');
    });

    it('returns the containing access root', () => {
        expect(workspaceForPath('/ws/a/sub', ['/ws/a', '/ws/b'])).toBe('/ws/a');
    });

    it('returns the deepest containing access root', () => {
        expect(workspaceForPath('/ws/a/deep/nested', ['/ws/a', '/ws/a/deep'])).toBe('/ws/a/deep');
    });

    it('keeps the deepest match when a shallower root is compared after a deeper one', () => {
        expect(workspaceForPath('/ws/a/deep/nested', ['/ws/a/deep', '/ws/a'])).toBe('/ws/a/deep');
    });

    it('matches the root itself', () => {
        expect(workspaceForPath('/ws/a', ['/ws/a'])).toBe('/ws/a');
    });

    it('resolves relative cwd against process.cwd()', () => {
        const cwd = process.cwd();
        expect(workspaceForPath('src', [cwd])).toBe(cwd);
    });

    it('resolves relative access roots against process.cwd()', () => {
        const cwd = process.cwd();
        expect(workspaceForPath(cwd, ['.'])).toBe(cwd);
    });

    it('does not confuse a sibling prefix with containment', () => {
        expect(workspaceForPath('/ws/abc', ['/ws/a'])).toBe('');
    });

    it('resolves access roots before matching', () => {
        expect(workspaceForPath('/ws/a/sub', ['/ws/a/'])).toBe('/ws/a');
    });

    it('treats the filesystem root as containing every path', () => {
        expect(workspaceForPath('/any/where', ['/'])).toBe('/');
    });
});
