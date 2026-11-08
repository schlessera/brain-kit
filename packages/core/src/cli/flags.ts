/**
 * Typed reads of parsed CLI flags (#1352). `parseArgs` stores a flag's value
 * as a string, or `true` when the flag has no value (it is last, or the next
 * argument is another `--flag`); a repeated flag keeps its last value. These
 * accessors turn a value of the wrong kind into a {@link UsageError} instead
 * of letting `true`, `NaN` or an unknown enum member flow into a query.
 *
 * Each returns `undefined` when the flag is absent, so a command keeps its own
 * default. Call them before opening the database: a malformed flag then runs
 * no query.
 */

import { type Flags, UsageError } from "./io.js";

/** The flag's string value. A flag given without a value is a usage error. */
export function stringFlag(flags: Flags, name: string): string | undefined {
  const raw = flags[name];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new UsageError(`--${name} needs a value`);
  return raw;
}

/**
 * The flag as a whole number of 1 or more. The whole argument must be an
 * integer literal, as for `brain list --limit`: `10abc` and `1.5` are refused
 * rather than read as 10 and 1, and `0` or a negative is refused rather than
 * passed on. There is no upper bound.
 */
export function positiveIntegerFlag(flags: Flags, name: string): number | undefined {
  const raw = flags[name];
  if (raw === undefined) return undefined;
  const value = typeof raw === "string" && /^-?\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(value >= 1)) {
    throw new UsageError(`--${name} must be a whole number of 1 or more, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/** The flag's value when it is one of `values`; anything else is a usage error. */
export function enumFlag<const T extends string>(flags: Flags, name: string, values: readonly T[]): T | undefined {
  const raw = flags[name];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !(values as readonly string[]).includes(raw)) {
    throw new UsageError(`--${name} must be one of ${values.join(", ")}, got ${JSON.stringify(raw)}`);
  }
  return raw as T;
}

/**
 * Every value of a repeatable flag, in order, read from the raw arguments
 * (`parseArgs` keeps only the last). Arguments after a bare `--` are
 * positional and never read as flags. A flag given without a value is a
 * usage error.
 */
export function repeatedFlag(argv: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--") break;
    if (argv[i] !== `--${name}`) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value`);
    values.push(value);
    i++;
  }
  return values;
}
