/** Deterministic JSON and digests shared by Apify consent, profiles and the run ledger. */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

/** Deterministic JSON: object keys sorted at every depth. */
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
