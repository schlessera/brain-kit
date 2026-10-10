/** Current Phase 2 output is measured separately from post-output safety gates. */
import { z } from "zod";
import { readHygieneLog, reconcile } from "../../../packages/core/src/lib/hygiene";
import { frontmatterLength } from "../../../packages/core/src/lib/document-parts";
import type { Taxonomy } from "../../../packages/core/src/lib/taxonomy";
import { DAY } from "./fixtures";
import { eligibleSnapshot } from "./prototype";
import { snapshot, assertInspectionUnchanged, assertReconciliationEffects } from "./effects";
import { runNative } from "./native";

const candidate = z.object({ category: z.literal("conflict"), path: z.string().min(1), evidence: z.string().min(1), message: z.string().min(1) }).strict();
export function validateCurrent(text: string, root: string, taxonomy: Taxonomy) {
  // The actual current skill's output shape is retained; no labels, scripted
  // answers or replacement instructions are provided to the native model.
  const raw = z.array(candidate).max(64).parse(JSON.parse(text));
  const accepted: z.infer<typeof candidate>[] = [], invalid: Array<{ candidate: z.infer<typeof candidate>; reason: string }> = [];
  for (const c of raw) {
    const secondary = eligibleSnapshot(root, taxonomy, c.path, DAY, false);
    // Evidence must be verbatim canonical body text. Requiring a span of the
    // private grammar here would zero the current arm's recall on exactly the
    // prose facts the narrow extractor cannot retrieve, and bias the comparison.
    const evidence = c.evidence.trim();
    const canonical = Object.keys(taxonomy.canonical).map(key => taxonomy.canonicalPath(key)).filter((p): p is string => !!p)
      .map(path => eligibleSnapshot(root, taxonomy, path, DAY, true))
      .find(s => s && evidence.length > 0 && s.raw.slice(frontmatterLength(s.raw)).includes(evidence));
    if (!secondary || !canonical || (Date.parse(canonical.updated) - Date.parse(secondary.updated)) / 86_400_000 < 7) {
      invalid.push({ candidate: c, reason: "Configured authority, eligible source, exact canonical evidence or recency missing" }); continue;
    }
    // A canonical source cannot also be a derivative; evidence is exact source
    // text, not generated replacement prose. Semantic correctness is scored
    // against independent goldens AFTER this gate, not assumed by containment.
    if (Object.keys(taxonomy.canonical).some(k => taxonomy.canonicalPath(k) === c.path)) {
      invalid.push({ candidate: c, reason: "Canonical file reported as derivative" }); continue;
    }
    accepted.push(c);
  }
  return { raw, accepted, invalid };
}

export async function collectCurrent(root: string, taxonomy: Taxonomy, output: string, token: string,
  options: Parameters<typeof runNative>[4] = {}) {
  const before = snapshot(root);
  const native = await runNative(root, output, token, undefined, options);
  const inspected = snapshot(root); assertInspectionUnchanged(before, inspected);
  const parsed = validateCurrent(native.receipt.result.result, root, taxonomy);
  const reconciliation = reconcile(root, [], new Map(), { now: new Date(DAY), extra: parsed.accepted, failedChecks: ["canonical-conflicts"] });
  const after = snapshot(root); assertReconciliationEffects(inspected, after);
  return { ...parsed, native, before, inspected, after, reconciliation, entries: readHygieneLog(root), replacement: null };
}
