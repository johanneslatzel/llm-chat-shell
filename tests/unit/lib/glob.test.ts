import { describe, it, expect } from 'vitest';
import { countLiterals, countWildcards, dominates, matchesPattern } from '../../../src/lib/glob.js';

describe('matchesPattern', () => {
    it('matches literal patterns exactly', () => {
        expect(matchesPattern('git push', 'git push')).toBe(true);
        expect(matchesPattern('git push', 'git add')).toBe(false);
    });

    it('matches wildcards', () => {
        expect(matchesPattern('git push', 'git *')).toBe(true);
        expect(matchesPattern('git push origin main', 'git push *')).toBe(true);
    });

    it('does not match a sibling', () => {
        expect(matchesPattern('/ws/a/file', '/ws/abc/*')).toBe(false);
    });
});

describe('dominates', () => {
    it('a literal pattern dominates a glob that matches it', () => {
        expect(dominates('git push', 'git *')).toBe(true);
        expect(dominates('git push origin main', 'git push *')).toBe(true);
    });

    it('a wildcard-containing pattern dominates nothing', () => {
        expect(dominates('git *', 'git push')).toBe(false);
        expect(dominates('ls ?', 'ls *')).toBe(false);
    });

    it('an unrelated pattern does not dominate', () => {
        expect(dominates('git push', 'rm *')).toBe(false);
    });

    it('a slash-free command dominates its wildcard prefix', () => {
        expect(dominates('rm -rf', 'rm *')).toBe(true);
    });
});

describe('countWildcards', () => {
    it('counts asterisk and question-mark wildcards', () => {
        expect(countWildcards('git push')).toBe(0);
        expect(countWildcards('git *')).toBe(1);
        expect(countWildcards('* *')).toBe(2);
        expect(countWildcards('ls ?')).toBe(1);
    });
});

describe('countLiterals', () => {
    it('counts non-wildcard characters', () => {
        expect(countLiterals('git push *')).toBe(9);
        expect(countLiterals('git p*')).toBe(5);
        expect(countLiterals('***')).toBe(0);
    });
});
