/**
 * Read a string environment variable with an optional fallback default.
 * Returns `defaultValue` when the variable is unset or empty.
 */
export function envString(key: string, defaultValue?: string): string | undefined {
    const value = process.env[key];
    if (value === undefined || value === '') {
        return defaultValue;
    }
    return value;
}

/**
 * Read an optional string environment variable.
 * Returns `undefined` when the variable is unset or empty.
 */
export function envOptionalString(key: string): string | undefined {
    return process.env[key] || undefined;
}

/**
 * Read an integer environment variable with an optional fallback default.
 * Returns `defaultValue` when the variable is unset, empty, or not a valid integer.
 */
export function envInt(key: string, defaultValue?: number): number | undefined {
    const value = process.env[key];
    if (value === undefined || value === '') {
        return defaultValue;
    }
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) {
        return defaultValue;
    }
    return parsed;
}

/**
 * Read a float environment variable with an optional fallback default.
 * Returns `defaultValue` when the variable is unset, empty, or not a valid number.
 */
export function envFloat(key: string, defaultValue?: number): number | undefined {
    const value = process.env[key];
    if (value === undefined || value === '') {
        return defaultValue;
    }
    const parsed = parseFloat(value);
    if (isNaN(parsed)) {
        return defaultValue;
    }
    return parsed;
}

/**
 * Read a boolean environment variable. Returns `true` only when the value is the string `"true"`.
 * Returns `defaultValue` when the variable is unset or empty.
 */
export function envBool(key: string, defaultValue: boolean): boolean {
    const value = process.env[key];
    if (value === undefined || value === '') {
        return defaultValue;
    }
    return value === 'true';
}

/**
 * Read an enum environment variable constrained to a set of valid string values.
 * Returns `defaultValue` when the variable is unset, empty, or not one of the
 * accepted values.
 *
 * @typeParam T - The string literal type of the valid values.
 */
export function envEnum<T extends string>(
    key: string,
    validValues: readonly T[],
    defaultValue?: T
): T | undefined {
    const value = process.env[key];
    if (value === undefined || value === '') {
        return defaultValue;
    }
    if (validValues.includes(value as T)) {
        return value as T;
    }
    return defaultValue;
}
