/** Markdown is authoritative. These concrete receipts acknowledge freshness, never a content edit. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { Glob } from "bun";
import { z } from "zod";
import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
import { isWithin } from "@schlessera/brain-common/internal/safe-path";
import type { JevChoiceAnswer } from "./jev.js";
import type { Taxonomy } from "./taxonomy.js";
import { safeResolve, writeFileSafely } from "./safe-path.js";
import { acceptsPropagation, PROPAGATION_MODEL, PROPAGATION_QUESTION_VERSION, propagationSettings, type PropagationConfig, type PropagationSettings } from "./propagation-policy.js";

export const PROPAGATION_REVIEWS_PATH = "context/hygiene/propagation-reviews.md";
export const propagationHash = (value: string): string => createHash("sha256").update(value).digest("hex");
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const choice = z.strictObject({ type: z.literal("choice"), choice: z.string(), confidence: z.number().min(0).max(1), probabilities: z.record(z.string(), z.number().min(0).max(1)) });
const receiptSchema = z.strictObject({
  path: z.string().min(1), fingerprint: sha, reviewedAt: z.string().datetime(),
  observationDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reference: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/), referenceKind: z.enum(["explicit", "derivative-commit"]),
  model: z.string().min(1), questionVersion: z.string().min(1),
  policy: z.strictObject({ minConfidence: z.number().min(0).max(1), crossChecks: z.boolean() }),
  derivativeSha256: sha, scope: z.string().min(1), sources: z.array(z.strictObject({ path: z.string(), sha256: sha, beforeSha256: sha })),
  answers: z.record(z.string(), choice),
});
export type PropagationReceipt = z.infer<typeof receiptSchema>;
export interface PropagationContext {
  path: string;
  derivative: string;
  scope: string;
  sources: { path: string; current: string }[];
  fingerprint: string;
  observationDay: string;
}
export class PropagationUnavailable extends Error {}

/** Contained regular UTF-8 Markdown, including canonical-path exclusion checks. */
export function propagationText(root: string, path: string, taxonomy: Taxonomy, settings: PropagationSettings): string {
  const absolute = safeResolve(root, path), canonicalRoot = safeResolve(root, ".");
  if (!absolute || !canonicalRoot || !path.endsWith(".md") || path.startsWith("context/hygiene/")) throw new PropagationUnavailable("unavailable-path");
  const canonical = relative(canonicalRoot, absolute).split("\\").join("/");
  const excluded = (p: string) => taxonomy.isExcludedPath(p) || settings.exclude.some(pattern => new Glob(pattern).match(p) || isWithin(pattern, p, { trailingSeparator: "boundary" }));
  if (excluded(path) || excluded(canonical)) throw new PropagationUnavailable("excluded-path");
  const stat = lstatSync(join(root, path));
  if (!stat.isFile() || stat.size > 160000) throw new PropagationUnavailable("unavailable-file");
  const bytes = readFileSync(absolute);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new PropagationUnavailable("non-utf8-source");
  return text;
}

export function propagationContext(root: string, taxonomy: Taxonomy, path: string, settings: PropagationSettings, now = new Date()): PropagationContext {
  const derivative = propagationText(root, path, taxonomy, settings);
  const data = parseFrontmatter(derivative, { dataOnly: true }).data;
  const rules = taxonomy.propagation.filter(rule => rule.source !== path && new Glob(rule.derivatives).match(path));
  const scopes = [...new Set(rules.map(r => r.scope).filter((s): s is string => !!s))];
  const declared = data.propagation_scope;
  if (declared !== undefined && (typeof declared !== "string" || !declared.trim())) throw new PropagationUnavailable("missing-scope");
  const scope = typeof declared === "string" && declared.trim() ? declared.trim() : scopes.length === 1 ? scopes[0]! : null;
  if (!scope || scope.length > 4000 || (declared !== undefined && typeof declared !== "string")) throw new PropagationUnavailable("missing-scope");
  const paths = new Set(rules.map(rule => rule.source));
  if (typeof data.generated_from === "string" && data.generated_from.endsWith(".md")) paths.add(posix.normalize(data.generated_from));
  paths.delete(path);
  if (!paths.size) throw new PropagationUnavailable("missing-source");
  const sources = [...paths].sort().map(source => ({ path: source, current: propagationText(root, source, taxonomy, settings) }));
  const observationDay = now.toISOString().slice(0, 10);
  const fingerprint = propagationHash(JSON.stringify({ path, derivative: propagationHash(derivative), scope, observationDay,
    sources: sources.map(s => ({ path: s.path, sha256: propagationHash(s.current) })),
    model: PROPAGATION_MODEL, version: PROPAGATION_QUESTION_VERSION }));
  return { path, derivative, scope, sources, fingerprint, observationDay };
}

export interface PropagationStore { text: string | null; receipts: PropagationReceipt[] }
export function readPropagationStore(root: string): PropagationStore {
  const absolute = safeResolve(root, PROPAGATION_REVIEWS_PATH);
  if (!absolute) throw new PropagationUnavailable("uncontained-review-log");
  const stat = lstatSync(join(root, PROPAGATION_REVIEWS_PATH), { throwIfNoEntry: false });
  if (!stat) return { text: null, receipts: [] };
  if (!stat.isFile() || stat.size > 1_000_000) throw new PropagationUnavailable("invalid-review-log");
  const text = readFileSync(absolute, "utf8");
  const parsed = parseFrontmatter(text, { dataOnly: true });
  const created = parsed.data.created;
  if (!(created instanceof Date && Number.isFinite(created.getTime())) && !(typeof created === "string" && /^\d{4}-\d{2}-\d{2}$/.test(created) && Number.isFinite(Date.parse(created)))) throw new PropagationUnavailable("invalid-review-log");
  const content = parsed.content.trim();
  const match = /^# Propagation freshness reviews\n\n```json\n([\s\S]+)\n```$/.exec(content);
  if (!match) throw new PropagationUnavailable("invalid-review-log");
  const receipts = z.array(receiptSchema).max(1000).parse(JSON.parse(match[1]!));
  if (new Set(receipts.map(r => r.path)).size !== receipts.length) throw new PropagationUnavailable("duplicate-review-receipt");
  return { text, receipts };
}

export function receiptMatches(receipt: PropagationReceipt | undefined, context: PropagationContext): receipt is PropagationReceipt {
  return !!receipt && receipt.model === PROPAGATION_MODEL && receipt.questionVersion === PROPAGATION_QUESTION_VERSION &&
    receipt.fingerprint === context.fingerprint && receipt.derivativeSha256 === propagationHash(context.derivative) &&
    receipt.observationDay === context.observationDay &&
    receipt.scope === context.scope && receipt.sources.length === context.sources.length &&
    context.sources.every((s, i) => receipt.sources[i]?.path === s.path && receipt.sources[i]?.sha256 === propagationHash(s.current));
}

/** Read-only audit uses existing receipts; it never asks a model or creates a file. */
export function acknowledgedPropagation(root: string, taxonomy: Taxonomy, config: PropagationConfig, now = new Date()): Set<string> {
  const settings = propagationSettings(config), acknowledged = new Set<string>();
  if (!settings.enabled) return acknowledged;
  const store = readPropagationStore(root);
  for (const receipt of store.receipts) {
    try {
      const context = propagationContext(root, taxonomy, receipt.path, settings, now);
      if (receiptMatches(receipt, context) && acceptsPropagation(receipt.answers as Record<string, JevChoiceAnswer>, settings)) acknowledged.add(receipt.path);
    } catch { /* Changed or unavailable evidence leaves the finding for its owner. */ }
  }
  return acknowledged;
}

export function writePropagationStore(root: string, store: PropagationStore, receipts: PropagationReceipt[], now: Date, recheck: () => void): void {
  const absolute = safeResolve(root, PROPAGATION_REVIEWS_PATH);
  if (!absolute || absolute !== join(safeResolve(root, ".")!, PROPAGATION_REVIEWS_PATH)) throw new PropagationUnavailable("uncontained-review-log");
  const day = now.toISOString().slice(0, 10);
  const created = store.text ? parseFrontmatter(store.text, { dataOnly: true }).data.created : day;
  const createdDay = created instanceof Date ? created.toISOString().slice(0, 10) : String(created);
  const text = `---\ntitle: Propagation freshness reviews\ntype: context\ncreated: ${createdDay}\nupdated: ${day}\ntags: [hygiene]\n---\n\n# Propagation freshness reviews\n\n\`\`\`json\n${JSON.stringify(receipts, null, 2)}\n\`\`\`\n`;
  if (receipts.length > 1000 || Buffer.byteLength(text) > 1_000_000) throw new PropagationUnavailable("review-log-limit");
  writeFileSafely(absolute, text, { beforePublish() {
    if (safeResolve(root, PROPAGATION_REVIEWS_PATH) !== absolute || readPropagationStore(root).text !== store.text) throw new PropagationUnavailable("review-log-changed");
    recheck();
  } });
}
