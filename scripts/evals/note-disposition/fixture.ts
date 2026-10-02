import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import rawFixtures from "./fixtures.json";
import { brainConfigSchema } from "../../../packages/core/src/lib/config";
import { buildTaxonomy } from "../../../packages/core/src/lib/taxonomy";
import type { Envelope, Proposal } from "./guard";

export const fixtures = z.array(z.strictObject({
  id: z.string().min(1), split: z.enum(["tuning", "held-out"]), group: z.string().min(1),
  category: z.string().min(1), source: z.string().min(1), target: z.string().nullable(),
  expected: z.enum(["merge", "promote", "keep"]), type: z.string().optional(), repeatTarget: z.number().int().positive().optional(),
})).parse(rawFixtures);
export type Fixture = typeof fixtures[number];

export function prepare(f: Fixture) {
  const root = mkdtempSync(join(tmpdir(), "brain-note-disposition-"));
  const config = brainConfigSchema.parse({
    reranker: { enabled: false },
    taxonomy: { types: { project: { dir: "projects/active" }, ritual: { dir: "rituals" } } },
  });
  const taxonomy = buildTaxonomy({ user: config });
  const document = (path: string, type: string, body: string) => {
    const raw = `---\ntitle: ${f.id}\ntype: ${type}\nstatus: active\ncreated: 2026-07-12\nupdated: 2026-07-12\ntags: []\n---\n${body}\n`;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), raw);
    return { path, raw };
  };
  const source = document(`notes/${f.id}.md`, "note", f.source);
  const targets = f.target === null ? [] : [document(`projects/active/${f.group}.md`, "project", Array(f.repeatTarget ?? 1).fill(f.target).join("\n"))];
  const env: Envelope = { root, source, targets, taxonomy, archiveApproved: false };
  return { env, config, close: () => rmSync(root, { recursive: true, force: true }) };
}

/** The mechanical baseline recognizes only an exact duplicate of a complete body. */
export function deterministic(f: Fixture, env: Envelope): Proposal {
  if (f.target === f.source && env.targets.length === 1) return {
    action: "merge", reasoning: "Exact duplicate; retaining the original source too.",
    operations: [{ op: "update", path: env.targets[0]!.path, content: `${f.target}\n` }],
  };
  return { action: "keep", reasoning: "No mechanical disposition proved.", operations: [] };
}

/** Oracle payload for exercising guards, never claimed to be model output. */
export function oracle(f: Fixture, env: Envelope): Proposal {
  if (f.expected === "keep") return { action: "keep", reasoning: "Fixture golden", operations: [] };
  return {
    action: f.expected, reasoning: "Fixture golden",
    operations: [{ op: f.expected === "merge" ? "update" : "create", path: f.expected === "merge" ? env.targets[0]!.path : `rituals/${f.id}.md`, content: `${f.target ? Array(f.repeatTarget ?? 1).fill(f.target).join("\n") + "\n" : ""}${f.source}\n` }],
  };
}
