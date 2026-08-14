import { describe, it, expect, beforeEach } from 'vitest';
import { envString, envOptionalString, envInt, envFloat, envEnum, envBool } from '../../src/lib/env.js';

beforeEach(() => {
    delete process.env.TEST_KEY;
    delete process.env.TEST_EMPTY;
    delete process.env.TEST_INT;
    delete process.env.TEST_FLOAT;
    delete process.env.TEST_BOOL;
});

describe('envString', () => {
    it('returns value when set', () => {
        process.env.TEST_KEY = 'hello';
        expect(envString('TEST_KEY')).toBe('hello');
    });

    it('returns default when not set', () => {
        expect(envString('TEST_KEY', 'default')).toBe('default');
    });

    it('returns default when empty string', () => {
        process.env.TEST_EMPTY = '';
        expect(envString('TEST_EMPTY', 'fallback')).toBe('fallback');
    });

    it('returns undefined when not set and no default', () => {
        expect(envString('TEST_KEY')).toBeUndefined();
    });
});

describe('envOptionalString', () => {
    it('returns value when set', () => {
        process.env.TEST_KEY = 'world';
        expect(envOptionalString('TEST_KEY')).toBe('world');
    });

    it('returns undefined when not set', () => {
        expect(envOptionalString('TEST_KEY')).toBeUndefined();
    });

    it('returns undefined when empty string', () => {
        process.env.TEST_EMPTY = '';
        expect(envOptionalString('TEST_EMPTY')).toBeUndefined();
    });
});

describe('envInt', () => {
    it('returns parsed integer', () => {
        process.env.TEST_INT = '42';
        expect(envInt('TEST_INT')).toBe(42);
    });

    it('returns default when not set', () => {
        expect(envInt('TEST_INT', 10)).toBe(10);
    });

    it('returns default when NaN', () => {
        process.env.TEST_INT = 'not-a-number';
        expect(envInt('TEST_INT', 0)).toBe(0);
    });

    it('returns undefined when not set and no default', () => {
        expect(envInt('TEST_INT')).toBeUndefined();
    });

    it('returns default when empty string', () => {
        process.env.TEST_EMPTY = '';
        expect(envInt('TEST_EMPTY', 99)).toBe(99);
    });
});

describe('envFloat', () => {
    it('returns parsed float', () => {
        process.env.TEST_FLOAT = '3.14';
        expect(envFloat('TEST_FLOAT')).toBe(3.14);
    });

    it('returns default when not set', () => {
        expect(envFloat('TEST_FLOAT', 1.5)).toBe(1.5);
    });

    it('returns default when NaN', () => {
        process.env.TEST_FLOAT = 'not-a-float';
        expect(envFloat('TEST_FLOAT', 0.0)).toBe(0.0);
    });

    it('returns undefined when not set and no default', () => {
        expect(envFloat('TEST_FLOAT')).toBeUndefined();
    });
});

describe('envEnum', () => {
    const VALID = ['a', 'b', 'c'] as const;

    it('returns value when valid', () => {
        process.env.TEST_KEY = 'a';
        expect(envEnum('TEST_KEY', VALID)).toBe('a');
    });

    it('returns default when invalid value', () => {
        process.env.TEST_KEY = 'z';
        expect(envEnum('TEST_KEY', VALID, 'b')).toBe('b');
    });

    it('returns default when not set', () => {
        expect(envEnum('TEST_KEY', VALID, 'c')).toBe('c');
    });

    it('returns undefined when not set and no default', () => {
        expect(envEnum('TEST_KEY', VALID)).toBeUndefined();
    });

    it('returns default when empty string', () => {
        process.env.TEST_EMPTY = '';
        expect(envEnum('TEST_EMPTY', VALID, 'a')).toBe('a');
    });
});

describe('envBool', () => {
    it('returns true when value is "true"', () => {
        process.env.TEST_BOOL = 'true';
        expect(envBool('TEST_BOOL', false)).toBe(true);
    });

    it('returns false when value is not "true"', () => {
        process.env.TEST_BOOL = 'yes';
        expect(envBool('TEST_BOOL', false)).toBe(false);
    });

    it('returns default when not set', () => {
        expect(envBool('TEST_BOOL', true)).toBe(true);
    });

    it('returns default when empty string', () => {
        process.env.TEST_EMPTY = '';
        expect(envBool('TEST_EMPTY', true)).toBe(true);
    });

    it('returns false for "false" string', () => {
        process.env.TEST_BOOL = 'false';
        expect(envBool('TEST_BOOL', true)).toBe(false);
    });
});
