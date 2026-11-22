import {
    createEnvReader,
    EmptyStringPolicy,
    NumberParsing,
    RangePolicy
} from '@johannes.latzel/env';

function makeEnv() {
    return createEnvReader({
        emptyString: EmptyStringPolicy.Unset,
        numberParsing: NumberParsing.Lenient,
        rangePolicy: RangePolicy.Fallback,
        booleanTrue: ['true'],
        booleanFalse: ['false']
    });
}

/** Read a string environment variable with an optional fallback default. */
export function envString(key: string, defaultValue?: string): string | undefined {
    return makeEnv().string(key, defaultValue);
}

/** Read an optional string environment variable. */
export function envOptionalString(key: string): string | undefined {
    return makeEnv().optionalString(key);
}

/** Read an integer environment variable with an optional fallback default. */
export function envInt(key: string, defaultValue?: number): number | undefined {
    return makeEnv().int(key, defaultValue);
}

/** Read a float environment variable with an optional fallback default. */
export function envFloat(key: string, defaultValue?: number): number | undefined {
    return makeEnv().float(key, defaultValue);
}

/** Read a boolean environment variable. */
export function envBool(key: string, defaultValue: boolean): boolean {
    return makeEnv().bool(key, defaultValue);
}

/** Read an enum environment variable constrained to a set of valid string values. */
export function envEnum<T extends string>(
    key: string,
    validValues: readonly T[],
    defaultValue?: T
): T | undefined {
    return makeEnv().enum(key, validValues, defaultValue);
}
