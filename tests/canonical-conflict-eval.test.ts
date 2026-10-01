import { expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtures, prepare, DAY, YES, UNKNOWN } from "../scripts/evals/canonical-conflicts/fixtures";
import { pairs, inspect, extract } from "../scripts/evals/canonical-conflicts/prototype";
import { controlReport } from "../scripts/evals/canonical-conflicts/run";
import { reconcile, readHygieneLog, hygieneId } from "../packages/core/src/lib/hygiene";
import { brainConfigSchema } from "../packages/core/src/lib/config";
import { buildTaxonomy } from "../packages/core/src/lib/taxonomy";

const record = (p: ReturnType<typeof prepare>, result: Awaited<ReturnType<typeof inspect>>, incomplete = false) => {
  const r = reconcile(p.root, [], new Map(), { now: new Date(DAY), extra: result ? [result.candidate] : [], failedChecks: incomplete ? ["canonical-conflicts"] : [] });
  return { r, entries: readHygieneLog(p.root).filter(e => e.id.startsWith("conflict-")) };
};

test("draft IDs are unique and held-out groups do not cross tuning", () => {
  expect(new Set(fixtures.map(f => f.id)).size).toBe(fixtures.length);
  const tuning = new Set(fixtures.filter(f => f.split === "tuning").map(f => f.group));
  expect(tuning.size).toBeGreaterThan(0); expect(fixtures.filter(f => f.split === "held-out").length).toBeGreaterThan(0);
  for (const f of fixtures.filter(f => f.split === "held-out")) expect(tuning.has(f.group)).toBe(false);
});

test("abstention retains an existing conflict through the real failed-check reconciliation path", async () => {
  const p = prepare(fixtures[0]!);
  try {
    const pair = pairs(p.root, p.taxonomy, DAY)[0]!;
    expect(record(p, await inspect(p.root, p.taxonomy, pair, DAY, async () => YES)).entries).toHaveLength(1);
    const abstained = await inspect(p.root, p.taxonomy, pair, DAY, async () => UNKNOWN);
    expect(abstained).toBeNull();
    const retained = record(p, abstained, true);
    expect(retained.r.resolved).toBe(0);
    expect(retained.r.failedChecks).toEqual(["canonical-conflicts"]);
    expect(retained.entries).toHaveLength(1);
    expect(retained.entries[0]!.state).toBe("open");
    expect(retained.r.changedFiles).toEqual([]);
  } finally { p.close(); }
});

for (const f of fixtures) test(`${f.id}: actual extraction and fake judgments reach the existing Markdown log`, async () => {
  const p = prepare(f); let calls = 0;
  try {
    const retrieved = pairs(p.root, p.taxonomy, DAY);
    expect(retrieved.length > 0).toBe(f.retrieval);
    const results = [];
    for (const pair of retrieved) {
      const result = await inspect(p.root, p.taxonomy, pair, DAY, async () => f.answers[Math.min(calls++, f.answers.length - 1)]);
      if (result) results.push(result);
    }
    expect(results.length > 0).toBe(f.expected);
    const written = record(p, results[0] ?? null);
    expect(written.entries.length).toBe(f.expected ? 1 : 0);
    if (f.expected) {
      const result = results[0]!;
      expect(result.replacement).toBeNull();
      expect(result.candidate.evidence).toBe(f.anchor);
      expect(result.id).toBe(hygieneId("conflict", "profiles/record.md", f.anchor));
      expect(result.provenance.secondary.text).toBe(f.other);
      expect(readFileSync(join(p.root, "context/hygiene/open.md"), "utf8")).toContain(f.anchor);
      const repeated = record(p, result); expect(repeated.r.changedFiles).toEqual([]); expect(repeated.entries).toHaveLength(1);
    }
    for (const [path, raw] of Object.entries(p.files)) expect(readFileSync(join(p.root, path), "utf8")).toBe(raw);
  } finally { p.close(); }
});

test("same-subject guard prevents a false conflict from entering the real log", async () => {
  const p = prepare(fixtures[0]!);
  try {
    const pair = pairs(p.root, p.taxonomy, DAY)[0]!; expect(pair.anchor.text.length).toBeGreaterThan(0);
    const result = await inspect(p.root, p.taxonomy, pair, DAY, async () => ({ sameSubject: "no", contradiction: "yes" }));
    expect(record(p, result).entries).toEqual([]);
  } finally { p.close(); }
});

test("recency guard prevents a speculative conflict from entering the real log", async () => {
  const p = prepare(fixtures.find(f => f.id === "recent-gap")!);
  try { const pair = pairs(p.root, p.taxonomy, DAY)[0]!; expect(pair.restatement.text.length).toBeGreaterThan(0);
    expect(record(p, await inspect(p.root, p.taxonomy, pair, DAY, async () => YES)).entries).toEqual([]);
  } finally { p.close(); }
});

test("provenance guard prevents changed source evidence from entering the real log", async () => {
  const p = prepare(fixtures[0]!); let calls = 0;
  try {
    const pair = pairs(p.root, p.taxonomy, DAY)[0]!;
    const result = await inspect(p.root, p.taxonomy, pair, DAY, async () => {
      if (++calls === 2) writeFileSync(join(p.root, pair.secondary.path), pair.secondary.raw.replace("carpenter", "navigator"));
      return YES;
    });
    expect(calls).toBe(2); expect(record(p, result).entries).toEqual([]);
  } finally { p.close(); }
});

test("exact span provenance rejects invented offsets and missing anchors", async () => {
  const p = prepare(fixtures[0]!);
  try {
    const pair = pairs(p.root, p.taxonomy, DAY)[0]!;
    expect(pair.canonical.raw.slice(pair.anchor.start, pair.anchor.end)).toBe(pair.anchor.text);
    const forged = { ...pair, anchor: { ...pair.anchor, start: 0 } };
    expect(record(p, await inspect(p.root, p.taxonomy, forged, DAY, async () => YES)).entries).toEqual([]);
    unlinkSync(join(p.root, pair.canonical.path)); expect(pairs(p.root, p.taxonomy, DAY)).toEqual([]);
    expect(await inspect(p.root, p.taxonomy, pair, DAY, async () => YES)).toBeNull();
  } finally { p.close(); }
});

test("report identity and relevant evidence survive unrelated edits while source snapshots expire", async () => {
  const p = prepare(fixtures[0]!);
  try {
    const original = pairs(p.root, p.taxonomy, DAY)[0]!; const first = await inspect(p.root, p.taxonomy, original, DAY, async () => YES);
    expect(first).not.toBeNull();
    writeFileSync(join(p.root, original.secondary.path), original.secondary.raw + "\n# Unrelated heading\n");
    expect(await inspect(p.root, p.taxonomy, original, DAY, async () => YES)).toBeNull();
    const next = await inspect(p.root, p.taxonomy, pairs(p.root, p.taxonomy, DAY)[0]!, DAY, async () => YES);
    expect(next!.id).toBe(first!.id); expect(next!.evidenceDigest).toBe(first!.evidenceDigest);
    writeFileSync(join(p.root, original.secondary.path), original.secondary.raw.replace("carpenter", "sailor"));
    const changed = await inspect(p.root, p.taxonomy, pairs(p.root, p.taxonomy, DAY)[0]!, DAY, async () => YES);
    expect(changed!.id).toBe(first!.id); expect(changed!.evidenceDigest).not.toBe(first!.evidenceDigest);
  } finally { p.close(); }
});

test("invalid, missing, unknown, throwing and order-inconsistent answers grant no replacement", async () => {
  const p = prepare(fixtures[0]!);
  try {
    const pair = pairs(p.root, p.taxonomy, DAY)[0]!;
    for (const value of [null, {}, UNKNOWN, { sameSubject: true, contradiction: true }, { ...YES, confidence: 1, replacement: "delete" }]) {
      expect(record(p, await inspect(p.root, p.taxonomy, pair, DAY, async () => value)).entries).toEqual([]);
    }
    expect(await inspect(p.root, p.taxonomy, pair, DAY, async () => { throw new Error("offline timeout"); })).toBeNull();
    expect(existsSync(join(p.root, "me/anchor.md"))).toBe(true);
  } finally { p.close(); }
});

test("date validation and GFM boundaries do not invent fact spans", async () => {
  for (const date of ["2026-02-30", "2026-07-13", "yesterday"]) {
    const p = prepare({ ...fixtures[0]!, canonicalDate: date });
    try { expect(pairs(p.root, p.taxonomy, DAY)).toEqual([]); } finally { p.close(); }
  }
  expect(extract("> Odysseus: Role = king\n\n```\nOdysseus: Role = king\n```\n\nOdysseus: Role = `king`\n")).toEqual([]);
});

test("complete untrusted documents and exact spans are supplied in both orders", async () => {
  const p = prepare(fixtures[0]!); const seen: Array<[string, string, string, string]> = [];
  try {
    const path = "profiles/record.md"; const noise = "\nOdysseus keeps an unrelated voyage diary.\n".repeat(500);
    writeFileSync(join(p.root, path), p.files[path]! + noise);
    const pair = pairs(p.root, p.taxonomy, DAY)[0]!;
    const result = await inspect(p.root, p.taxonomy, pair, DAY, async (a, b) => { seen.push([a.document, a.span.text, b.document, b.span.text]); return YES; });
    expect(record(p, result).entries).toHaveLength(1);
    expect(seen).toEqual([[pair.canonical.raw, pair.anchor.text, pair.secondary.raw, pair.restatement.text], [pair.secondary.raw, pair.restatement.text, pair.canonical.raw, pair.anchor.text]]);
    expect(seen[0]![2]).toContain(noise);
  } finally { p.close(); }
});

test("configured authority, archive and taxonomy exclusions remain code gates", async () => {
  const p = prepare(fixtures[0]!);
  try {
    const pair = pairs(p.root, p.taxonomy, DAY)[0]!;
    p.taxonomy.canonical.identity = "me/unset.md";
    expect(record(p, await inspect(p.root, p.taxonomy, pair, DAY, async () => YES)).entries).toEqual([]);
    p.taxonomy.canonical.identity = "me/anchor.md";
    const excluded = buildTaxonomy({ user: brainConfigSchema.parse({ ...p.config, exclude: { files: ["profiles/record.md"] } }) });
    expect(pairs(p.root, excluded, DAY)).toEqual([]);
    writeFileSync(join(p.root, pair.secondary.path), pair.secondary.raw.replace("status: active", "status: archived"));
    expect(pairs(p.root, p.taxonomy, DAY)).toEqual([]);
  } finally { p.close(); }
});

test("offline report retains a known retrieval miss and leaves live adoption metrics unmeasured", async () => {
  const r = await controlReport(); expect(r.results.every(x => x.correct)).toBe(true); expect(r.cases).toBe(21);
  expect(r.draftCandidateRecall).toEqual({ positives: 6, retrieved: 5 });
  expect(r.adoption).toBe("not measured"); expect(r.replacement).toBe("not proposed");
  for (const metric of Object.values(r.live)) expect(metric).toBeNull();
});

test("code controls numeric and calendar differences even when scripted contradiction answers are wrong", async () => {
  for (const [id, judgment, expected] of [["numeric-equivalence", YES, 0], ["numeric-difference", { sameSubject: "yes", contradiction: "no" }, 1], ["date-difference", { sameSubject: "yes", contradiction: "unknown" }, 1]] as const) {
    const p = prepare(fixtures.find(f => f.id === id)!);
    try { const pair = pairs(p.root, p.taxonomy, DAY)[0]!;
      expect(record(p, await inspect(p.root, p.taxonomy, pair, DAY, async () => judgment)).entries).toHaveLength(expected);
    } finally { p.close(); }
  }
  const p = prepare({ ...fixtures[0]!, anchor: "Odysseus: Count = 9007199254740992", other: "Odysseus: Count = 9007199254740993" });
  try { expect(record(p, await inspect(p.root, p.taxonomy, pairs(p.root, p.taxonomy, DAY)[0]!, DAY, async () => YES)).entries).toHaveLength(1); }
  finally { p.close(); }
});
