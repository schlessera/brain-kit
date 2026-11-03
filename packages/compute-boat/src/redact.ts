/**
 * Redaction for everything the adapter writes outside the request itself:
 * log lines and the `reason` of an outcome. The instance key and every signed
 * file URL Boat issued during the call are removed verbatim; anything shaped
 * like a Boat key (new or legacy) or a URL query string is removed by pattern
 * as well, so a vendor message that echoes one cannot carry it into a job
 * record. Boat's own error codes are kept.
 */

import type { ComputeLogger } from "@schlessera/brain";

const MASK = "[redacted]";
/**
 * A Boat key, new (`boat_`) or legacy (`box_`). Boat's error codes share the
 * prefix (`boat_direct_failed`), so a match counts only when its tail is long
 * and carries a digit or a capital, as a random token does and a lower-case
 * snake_case code never does.
 */
const KEY_SHAPE = /\b(?:boat|box)_[A-Za-z0-9_-]{12,}/g;
const keyLike = (match: string) => (/[0-9A-Z]/.test(match.slice(match.indexOf("_") + 1)) ? MASK : match);
const URL_QUERY = /(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g;

export interface Redactor {
  /** Treat `value` as secret for the rest of this call. */
  add(value: string | undefined): void;
  text(value: string): string;
  log(base: ComputeLogger): ComputeLogger;
}

export function createRedactor(secret: string | undefined): Redactor {
  const secrets = new Set<string>();
  const add = (value: string | undefined) => {
    if (value && value.length >= 4) secrets.add(value);
  };
  add(secret);
  const text = (value: string): string => {
    let out = value;
    for (const s of secrets) out = out.split(s).join(MASK);
    return out.replace(KEY_SHAPE, keyLike).replace(URL_QUERY, `$1?${MASK}`);
  };
  const scrub = (value: unknown, depth = 0): unknown => {
    if (typeof value === "string") return text(value);
    if (depth > 4 || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, depth + 1)]));
  };
  return {
    add,
    text,
    log: (base) => ({
      debug: (message, data) => base.debug(text(message), data && (scrub(data) as Record<string, unknown>)),
      warn: (message, data) => base.warn(text(message), data && (scrub(data) as Record<string, unknown>)),
    }),
  };
}
