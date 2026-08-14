import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        pool: 'forks',
        include: ['tests/**/*.test.ts'],
        exclude: ['dist/**', 'node_modules/**'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html', 'lcov'],
            include: ['src/**/*.ts'],
            exclude: ['src/index.ts'],
            reportOnFailure: true,
            thresholds: {
                statements: 100,
                branches: 100,
                functions: 100,
                lines: 100,
            },
        },
    },
});
