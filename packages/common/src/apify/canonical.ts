/** Deterministic JSON and digests shared by Apify consent, profiles and the run ledger. */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

/**
 * Deterministic JSON: object keys sorted by code unit at every depth. An
 * `undefined` member or element and a non-finite number are written as
 * `null`, `-0` as `0`, and a non-plain object such as a `Date` by its own
 * enumerable keys (so `{}`).
 *
 * The Apify schema, pricing and input digests and the approval keys hash this
 * text, and recorded consents and ledger rows store those hashes: the rule
 * must not change, or every stored approval stops matching.
 * `packages/common/tests/apify-canonical.test.ts` pins it. A new caller should
 * not reuse this lax rule; the schedule canonicaliser's, which refuses
 * anything it cannot represent exactly (`packages/ui-server/src/schedules/canonical.ts`),
 * is the one to copy.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** One brain's stable identity in the Apify ledger: the same for the server and the CLI on that brain. */
export function apifyBrainId(root: string): string {
  let canonical = root;
  try { canonical = realpathSync(root); } catch { /* a missing brain keeps its spelling */ }
  return sha256(`brain:${canonical}`).slice(0, 32);
}
