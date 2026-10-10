/** Actual audit tag-noise judgment, scoped to report-only proposals. */
import { z } from "zod";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectTaggedDocuments } from "../../../packages/core/src/lib/tags";
import { initContext } from "../../../packages/core/src/lib/context";
import { hash, snapshot } from "./prototype";
import { runNative } from "./native";
const output = z.array(z.object({ from: z.string().min(1), to: z.string().min(1), reason: z.string().min(1),
  documents: z.array(z.string().min(1)).min(1) }).strict()).max(128);
export function parseCurrent(value: string) {
  try { return output.safeParse(JSON.parse(value)); } catch { return output.safeParse(null); }
}
export async function collectCurrent(root: string, destination: string, token: string, options: Parameters<typeof runNative>[4] = {}) {
  const before = snapshot(root), native = await runNative(root, destination, token, undefined, options), after = snapshot(root);
  if (hash(JSON.stringify(before)) !== hash(JSON.stringify(after))) throw Error("Unexpected inspection effects in report-only tag review");
  const text = native.receipt.result.result;
  const parsed = parseCurrent(typeof text === "string" ? text : "");
  if (!parsed.success) throw Error("Invalid current audit tag proposal output retained in raw native receipt");
  const brain = await initContext({ root });
  const docs = collectTaggedDocuments(root, brain.taxonomy), vocabulary = brain.taxonomy.tags?.vocabulary ?? [], aliases = brain.taxonomy.tags?.aliases ?? {};
  const accepted: Array<(typeof parsed.data)[number]> = [], invalid: Array<{ proposal: (typeof parsed.data)[number]; reason: string }> = [];
  const emitted = new Set<string>();
  for (const row of parsed.data) {
    const usages = docs.filter(d => d.tags.includes(row.from) || d.tags.includes(row.to));
    const paths = new Set(usages.map(d => d.path)), tags = new Set(usages.flatMap(d => d.tags));
    const reason = row.from === row.to || !tags.has(row.from) || !tags.has(row.to) || !vocabulary.includes(row.to) || vocabulary.includes(row.from) ||
      Object.hasOwn(aliases, row.to) || (Object.hasOwn(aliases, row.from) && aliases[row.from] !== row.to) ||
      row.documents.some(p => !paths.has(p)) || !row.documents.some(p => docs.some(d => d.path === p && d.tags.includes(row.from))) ||
      !row.documents.some(p => docs.some(d => d.path === p && d.tags.includes(row.to)))
      ? "Missing actual source/target usage, configured target or representative evidence; alias conflict" : null;
    if (reason) invalid.push({ proposal: row, reason });
    else if (emitted.has(hash(JSON.stringify([row.from, row.to])))) invalid.push({ proposal: row, reason: "Duplicate current proposal" });
    else { emitted.add(hash(JSON.stringify([row.from, row.to]))); accepted.push(row); }
  }
  const sourceFiles = Object.fromEntries(docs.map(d => [d.path, hash(readFileSync(join(root, d.path)))]));
  const afterValidation = snapshot(root);
  if (hash(JSON.stringify(before)) !== hash(JSON.stringify(afterValidation))) throw Error("Unexpected effects during current proposal validation");
  return { raw: parsed.data, accepted, invalid, before, after: afterValidation, sourceFiles, native,
    snapshotSha: hash(JSON.stringify(before)), explicitReview: null, applied: false,
    replacementAuthority: false, semanticCorrectness: null, explicitAbstention: null, actualInvoiceUsd: null };
}
