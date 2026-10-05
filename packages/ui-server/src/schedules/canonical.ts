import { createHash } from "node:crypto";

/**
 * Canonical JSON for schedule fingerprints: object keys sorted by code point,
 * array order kept, only finite numbers/strings/booleans/null. Negative zero
 * becomes zero. Anything else (undefined, functions, Dates, Buffers) throws.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean": return value ? "true" : "false";
    case "string": return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("Non-finite number in canonical JSON");
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
        throw new TypeError("Non-plain object in canonical JSON");
      const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`Unsupported ${typeof value} in canonical JSON`);
  }
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Lowercase SHA-256 of `brain.schedule.v1\n` plus the canonical approval subject. */
export function scheduleFingerprint(subject: {
  definition: unknown;
  rootIdentity: string;
  creatorPrincipalId: string;
  executionPolicy: unknown;
}): string {
  return sha256Hex(`brain.schedule.v1\n${canonicalJson(subject)}`);
}

/**
 * Strict JSON text parsing: rejects duplicate object keys, which JSON.parse
 * silently resolves to the last value, and nesting deeper than `maxDepth`.
 * The text must already be valid UTF-8 (decode with `fatal: true`).
 */
export function parseStrictJson(text: string, maxDepth = 32): unknown {
  let i = 0;
  const fail = (): never => { throw new SyntaxError("Invalid JSON"); };
  const ws = () => { while (i < text.length && " \t\n\r".includes(text[i]!)) i++; };
  const string = (): string => {
    const start = i;
    if (text[i] !== '"') fail();
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") i++;
      i++;
    }
    if (text[i] !== '"') fail();
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (depth: number): void => {
    if (depth > maxDepth) fail();
    ws();
    const c = text[i];
    if (c === "{") {
      i++; ws();
      const keys = new Set<string>();
      if (text[i] === "}") { i++; return; }
      for (;;) {
        ws();
        const key = string();
        if (keys.has(key)) throw new SyntaxError("Duplicate JSON key");
        keys.add(key);
        ws();
        if (text[i] !== ":") fail();
        i++;
        value(depth + 1);
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; return; }
        fail();
      }
    } else if (c === "[") {
      i++; ws();
      if (text[i] === "]") { i++; return; }
      for (;;) {
        value(depth + 1);
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "]") { i++; return; }
        fail();
      }
    } else if (c === '"') {
      string();
    } else {
      const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 400));
      if (!match) fail();
      i += match![0].length;
    }
  };
  value(0);
  ws();
  if (i !== text.length) fail();
  // Structure and keys are verified; JSON.parse produces the identical value.
  const parsed = JSON.parse(text) as unknown;
  assertFiniteJson(parsed);
  return parsed;
}

function assertFiniteJson(value: unknown): void {
  if (typeof value === "number" && !Number.isFinite(value)) throw new SyntaxError("Non-finite JSON number");
  if (value && typeof value === "object") for (const child of Object.values(value)) assertFiniteJson(child);
}
