// Private #840 experiment. This validates proposals; it never applies them.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { parseFrontmatter } from "../../../packages/common/src/frontmatter-parse";
import { safeResolve } from "../../../packages/core/src/lib/safe-path";
import type { Taxonomy } from "../../../packages/core/src/lib/taxonomy";

const operation = z.strictObject({
  op: z.enum(["create", "update", "archive"]),
  path: z.string().min(1),
  content: z.string(),
});
const proposal = z.strictObject({
  action: z.enum(["merge", "promote", "keep"]),
  reasoning: z.string().min(1),
  operations: z.array(operation).max(2),
});
export type Proposal = z.infer<typeof proposal>;
export interface Snapshot { path: string; raw: string }
export interface Envelope {
  root: string;
  source: Snapshot;
  targets: readonly Snapshot[];
  taxonomy: Taxonomy;
  // Independent operation authorization, never a classifier probability.
  archiveApproved: boolean;
}
export type Validation = { ok: true; proposal: Proposal } | { ok: false; reason: string };

function contained(root: string, path: string): string | null {
  if (isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => !part || part.startsWith("."))) return null;
  return safeResolve(root, path);
}

function current(root: string, doc: Snapshot): boolean {
  const abs = contained(root, doc.path);
  return abs !== null && existsSync(abs) && readFileSync(abs, "utf8") === doc.raw;
}

/** Conservative verbatim retention oracle, not semantic equivalence or a write boundary. */
export function validateProposal(input: unknown, env: Envelope): Validation {
  const parsed = proposal.safeParse(input);
  const reject = (reason: string): Validation => ({ ok: false, reason });
  if (!parsed.success) return reject("malformed proposal");
  const p = parsed.data;
  if (!current(env.root, env.source)) return reject("source changed or escaped");
  if (p.action === "keep") return p.operations.length === 0 ? { ok: true, proposal: p } : reject("keep has operations");
  const paths = new Set<string>();
  for (const op of p.operations) {
    if (!contained(env.root, op.path)) return reject("operation escaped");
    if (paths.has(op.path)) return reject("duplicate operation path");
    paths.add(op.path);
  }
  const writes = p.operations.filter((op) => op.op !== "archive");
  const archives = p.operations.filter((op) => op.op === "archive");
  if (writes.length !== 1) return reject("requires exactly one content operation");
  if (archives.length && (!env.archiveApproved || archives.length !== 1 || archives[0]!.path !== env.source.path || archives[0]!.content !== "")) return reject("archive not authorized");
  const write = writes[0]!;
  if (write.path === env.source.path) return reject("source overwrite");
  const source = parseFrontmatter(env.source.raw).content;
  if (!source.trim() || !write.content.includes(source)) return reject("source content lost");
  if (p.action === "merge") {
    if (write.op !== "update") return reject("merge requires update");
    const target = env.targets.find((doc) => doc.path === write.path);
    if (!target || !current(env.root, target)) return reject("target missing or changed");
    const body = parseFrontmatter(target.raw).content;
    if (!body.trim() || !write.content.includes(body)) return reject("target content lost");
    const type = parseFrontmatter(target.raw).data.type;
    if (typeof type !== "string" || !Object.hasOwn(env.taxonomy.types, type)) return reject("unknown target type");
  } else {
    if (write.op !== "create" || existsSync(contained(env.root, write.path)!)) return reject("promote requires new path");
    const type = env.taxonomy.typeForPath(write.path);
    const prefixes = env.taxonomy.expectedPrefixesFor(type);
    if (!Object.hasOwn(env.taxonomy.types, type) || type === env.taxonomy.inboxType() || !prefixes?.some((prefix) => write.path.startsWith(prefix)) || !write.path.endsWith(".md")) return reject("unknown promotion type or directory");
  }
  return { ok: true, proposal: p };
}

export interface Judgment {
  disposition: "keep" | "merge" | "promote" | "complex";
  target: string | null;
  confidence: number;
}
export type Route = { disposition: "keep" | "merge" | "promote"; target: string | null; generate: boolean; escalated: boolean };
/** Threshold must be supplied by the experiment; no borrowed production threshold. */
export function routeJudgment(value: unknown, candidatePaths: readonly string[], threshold: number): Route {
  const fallback: Route = { disposition: "keep", target: null, generate: false, escalated: true };
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("invalid experimental threshold");
  const result = z.strictObject({ disposition: z.enum(["keep", "merge", "promote", "complex"]), target: z.string().nullable(), confidence: z.number().min(0).max(1) }).safeParse(value);
  if (!result.success || result.data.confidence < threshold || result.data.disposition === "complex") return fallback;
  const j = result.data;
  if (j.disposition === "complex") return fallback;
  if (j.disposition === "merge" ? j.target === null || !candidatePaths.includes(j.target) : j.target !== null) return fallback;
  return { disposition: j.disposition, target: j.target, generate: j.disposition !== "keep", escalated: false };
}
