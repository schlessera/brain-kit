// Independently review these GPT-authored inputs and complete file goldens before live calls.
import raw from "./benchmark.json";
import { z } from "zod";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { brainConfigSchema } from "../../../packages/core/src/lib/config";
import { buildTaxonomy } from "../../../packages/core/src/lib/taxonomy";
import { parseFrontmatter } from "../../../packages/core/src/lib/frontmatter-parse";
import type { Envelope, Proposal } from "./guard";
export const benchmark = z.array(z.strictObject({
    id: z.string(), split: z.enum(["tuning", "held-out"]), entity: z.string(), template: z.string(), category: z.string(),
    source: z.string(), sourcePath: z.string(), sourceRaw: z.string(),
    targets: z.array(z.strictObject({ id: z.string(), body: z.string(), path: z.string(), raw: z.string() })),
    expected: z.strictObject({ action: z.enum(["keep", "merge", "promote"]), target: z.string().nullable(), type: z.string().nullable() }),
    expectedFiles: z.record(z.string(), z.string()),
})).parse(raw);
export type Benchmark = typeof benchmark[number];
export const benchmarkSha = createHash("sha256").update(readFileSync(new URL("./benchmark.json", import.meta.url))).digest("hex");
export function prepareBenchmark(f: Benchmark) {
    const root = mkdtempSync(join(tmpdir(), "brain-disposition-live-"));
    const config = brainConfigSchema.parse({ reranker: { enabled: false }, taxonomy: { types: { project: { dir: "projects/active" }, ritual: { dir: "rituals" } } } });
    const taxonomy = buildTaxonomy({ user: config });
    const initialFiles = { [f.sourcePath]: f.sourceRaw, ...Object.fromEntries(f.targets.map(t => [t.path, t.raw])) };
    for (const [path, content] of Object.entries(initialFiles)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
    }
    const env: Envelope = { root, source: { path: f.sourcePath, raw: f.sourceRaw }, targets: f.targets.map(t => ({ path: t.path, raw: t.raw })), taxonomy, archiveApproved: false };
    return { env, config, initialFiles, close: () => rmSync(root, { recursive: true, force: true }) };
}
export function mechanicalProposal(f: Benchmark): Proposal {
    const matches = f.targets.filter(t => t.body === f.source);
    return matches.length === 1 ? { action: "merge", reasoning: "Unique exact complete-body duplicate", operations: [{ op: "update", path: matches[0]!.path, content: `${matches[0]!.body}\n` }] } : { action: "keep", reasoning: "No mechanically proved disposition", operations: [] };
}
/** Full document projections preserve source and existing metadata; proposals are never applied. */
export function projectFiles(f: Benchmark, p: Proposal) {
    const files = { [f.sourcePath]: f.sourceRaw, ...Object.fromEntries(f.targets.map(t => [t.path, t.raw])) };
    for (const op of p.operations) {
        if (op.op === "archive")
            throw new Error("Archive outside benchmark authorization");
        const original = op.op === "update" ? files[op.path] : f.sourceRaw;
        if (!original)
            throw new Error("Unknown update target");
        const body = parseFrontmatter(original).content;
        const header = original.slice(0, original.length - body.length);
        files[op.path] = (op.op === "create" ? header.replace("type: note\n", "type: ritual\n") : header) + op.content;
    }
    return files;
}
/** Exact canonical golden agreement is stricter than semantic equivalence; retain full projections for independent review. */
export function exactFiles(actual: Record<string, string>, expected: Record<string, string>) {
    const keys = Object.keys(actual).sort();
    return JSON.stringify(keys) === JSON.stringify(Object.keys(expected).sort()) && keys.every(k => actual[k] === expected[k]);
}
