import { expect, test, spyOn } from "bun:test";
import { join } from "node:path";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { fixtures, prepare, oracle } from "../scripts/evals/note-disposition/fixture";
import { routeJudgment, validateProposal } from "../scripts/evals/note-disposition/guard";
import { controlReport } from "../scripts/evals/note-disposition/run";
import { scoreReceipts } from "../scripts/evals/note-disposition/score";
import { processCommand } from "../packages/core/src/cli/commands/process";
import { indexAll } from "../packages/core/src/lib/indexer";
import { openDatabase } from "../packages/core/src/lib/db";

test("golden groups do not cross tuning and held-out documents", () => {
  const tuning = new Set(fixtures.filter(f => f.split === "tuning").map(f => f.group));
  expect(tuning.size).toBeGreaterThan(0);
  expect(fixtures.filter(f => f.split === "held-out").length).toBeGreaterThan(0);
  for (const f of fixtures.filter(f => f.split === "held-out")) expect(tuning.has(f.group)).toBe(false);
  expect(new Set(fixtures.map(f => f.id)).size).toBe(fixtures.length);
});

for (const f of fixtures) test(`${f.id}: a nonempty golden preserves source and full target`, () => {
  const p = prepare(f);
  try {
    const proposed = oracle(f, p.env);
    expect(f.source.length).toBeGreaterThan(0);
    if (f.expected !== "keep") expect(proposed.operations.length).toBeGreaterThan(0);
    const before = readFileSync(join(p.env.root, p.env.source.path), "utf8");
    expect(validateProposal(proposed, p.env)).toEqual({ ok: true, proposal: proposed });
    expect(readFileSync(join(p.env.root, p.env.source.path), "utf8")).toBe(before);
    for (const target of p.env.targets) expect(readFileSync(join(p.env.root, target.path), "utf8")).toBe(target.raw);
  } finally { p.close(); }
});

test("escaped actual symlink target is rejected before reading its content", () => {
  const p = prepare(fixtures.find(f => f.id === "sailing-addition")!);
  const outside = prepare(fixtures[0]!);
  try {
    symlinkSync(outside.env.root, join(p.env.root, "linked"));
    const target = { path: `linked/${outside.env.source.path}`, raw: outside.env.source.raw };
    const sourceBody = `${fixtures.find(f => f.id === "sailing-addition")!.source}\n`;
    const proposal = { action: "merge", reasoning: "Escape fixture", operations: [{ op: "update", path: target.path, content: `${fixtures[0]!.source}\n${sourceBody}` }] };
    const externalBefore = readFileSync(join(outside.env.root, outside.env.source.path), "utf8");
    expect(validateProposal(proposal, { ...p.env, targets: [target] })).toEqual({ ok: false, reason: "operation escaped" });
    expect(readFileSync(join(outside.env.root, outside.env.source.path), "utf8")).toBe(externalBefore);
  } finally { p.close(); outside.close(); }
});

test("source and target retention guards each reject an otherwise valid nonempty merge", () => {
  const f = fixtures.find(f => f.id === "sailing-addition")!;
  const p = prepare(f);
  try {
    const proposed = oracle(f, p.env);
    expect(proposed.operations.length).toBe(1);
    expect(validateProposal(proposed, p.env).ok).toBe(true);
    const losingSource = { ...proposed, operations: [{ ...proposed.operations[0]!, content: `${f.target}\n` }] };
    expect(validateProposal(losingSource, p.env)).toEqual({ ok: false, reason: "source content lost" });
    const losingTarget = { ...proposed, operations: [{ ...proposed.operations[0]!, content: `${f.source}\n` }] };
    expect(validateProposal(losingTarget, p.env)).toEqual({ ok: false, reason: "target content lost" });
  } finally { p.close(); }
});

test("malformed, invented, stale, archive and keep operations cannot become accepted proposals", () => {
  const f = fixtures.find(f => f.id === "sailing-addition")!;
  const p = prepare(f);
  try {
    const proposed = oracle(f, p.env);
    expect(validateProposal({ ...proposed, injected: true }, p.env).ok).toBe(false);
    expect(validateProposal({ ...proposed, action: "split" }, p.env).ok).toBe(false);
    expect(validateProposal({ ...proposed, action: "keep" }, p.env)).toEqual({ ok: false, reason: "keep has operations" });
    expect(validateProposal({ ...proposed, operations: [...proposed.operations, { op: "archive", path: p.env.source.path, content: "" }] }, p.env)).toEqual({ ok: false, reason: "archive not authorized" });
    expect(validateProposal({ ...proposed, operations: [{ ...proposed.operations[0]!, path: "projects/active/absent.md" }] }, p.env)).toEqual({ ok: false, reason: "target missing or changed" });
    writeFileSync(join(p.env.root, p.env.targets[0]!.path), `${p.env.targets[0]!.raw}\nA later edit.\n`);
    expect(validateProposal(proposed, p.env)).toEqual({ ok: false, reason: "target missing or changed" });
  } finally { p.close(); }
});

test("unknown promotion directories and prototype names cannot authorize creation", () => {
  const p = prepare(fixtures.find(f => f.id === "custom-ritual")!);
  try {
    const proposed = oracle(fixtures.find(f => f.id === "custom-ritual")!, p.env);
    expect(validateProposal(proposed, p.env).ok).toBe(true);
    for (const path of ["unconfigured/new.md", "notes/new.md", "constructor/new.md", "rituals/new.txt"]) {
      expect(validateProposal({ ...proposed, operations: [{ ...proposed.operations[0]!, path }] }, p.env)).toEqual({ ok: false, reason: "unknown promotion type or directory" });
    }
  } finally { p.close(); }
});

test("keep, unknown, complex and invalid targets perform no generation in the proposed route", () => {
  let generationCalls = 0;
  for (const value of [null, { disposition: "keep", target: null, confidence: 1 }, { disposition: "complex", target: null, confidence: 1 }, { disposition: "merge", target: "invented", confidence: 1 }, { disposition: "promote", target: null, confidence: 0.1 }]) {
    const route = routeJudgment(value, ["projects/active/sailing.md"], 0.9);
    if (route.generate) generationCalls++;
    expect(route.disposition).toBe("keep");
    expect(route.generate).toBe(false);
  }
  expect(generationCalls).toBe(0);
  expect(routeJudgment({ disposition: "merge", target: "projects/active/sailing.md", confidence: 0.95 }, ["projects/active/sailing.md"], 0.9).generate).toBe(true);
});

test("actual process command returns proposals without applying, reading full targets, or validating operation paths", async () => {
  const f = { ...fixtures[0]!, source: "harbor sentinel note", target: `harbor sentinel target\n${"An unrelated voyage detail. ".repeat(200)}TARGET-END-BEYOND-SNIPPET` };
  const p = prepare(f);
  const dbPath = join(p.env.root, "brain.db");
  const db = openDatabase(dbPath);
  await indexAll(db, { root: p.env.root, taxonomy: p.env.taxonomy, force: true, quiet: true });
  db.close();
  const output = spyOn(console, "log").mockImplementation(() => {});
  let prompt = "";
  const scripted = { action: "merge", reasoning: "scripted control", operations: [{ op: "update", path: "../outside.md", content: "replacement" }] };
  try {
    await processCommand.run([p.env.source.path], {
      json: true, brain: { root: p.env.root, dbPath, config: p.config, configPath: null, modules: [], taxonomy: p.env.taxonomy },
      completions: { id: "fixture", capabilities: { vision: false }, async complete(input) { prompt = input.prompt; return JSON.stringify(scripted); } },
    });
    expect(prompt).toContain(`(${p.env.targets[0]!.path}):`);
    expect(prompt).toContain(">>>harbor<<< >>>sentinel<<< target");
    expect(prompt).not.toContain("TARGET-END-BEYOND-SNIPPET");
    expect(JSON.parse(String(output.mock.calls[0]![0]))).toEqual(scripted);
    expect(readFileSync(join(p.env.root, p.env.source.path), "utf8")).toBe(p.env.source.raw);
    expect(readFileSync(join(p.env.root, p.env.targets[0]!.path), "utf8")).toBe(p.env.targets[0]!.raw);
  } finally { output.mockRestore(); p.close(); }
});

test("offline report leaves every live quality, price and latency metric unmeasured", () => {
  const r = controlReport();
  expect(r.cases).toBe(16);
  expect(r.oracleGuard.accepted).toBe(16);
  expect(r.adoption).toBe("not measured");
  expect(Object.keys(r.live)).toHaveLength(10);
  for (const metric of Object.values(r.live)) expect(metric).toBeNull();
});

test("scoring separates partitions and cache, counts fallback work, and vetoes wrong-target decisions", () => {
  const f = fixtures.find(item => item.id === "watch-addition")!;
  const p = prepare(f);
  try {
    const sha = controlReport().fixtureSha256;
    const row = {
      fixture: f.id, arm: "hybrid", repetition: 0, predicted: "merge", target: p.env.targets[0]!.path,
      escalated: false, proposal: oracle(f, p.env), runtime: "fixture-runtime", fixtureSha256: sha,
      promptVersion: "fixture-v1", cache: "cold", totalLatencyMs: 30,
      calls: [{ kind: "classification", model: "fixture-only", inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, billedCostUsd: null, effectiveCostUsd: null },
        { kind: "fallback", model: "fixture-only", inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, billedCostUsd: 0.01, effectiveCostUsd: 0.01 }],
    };
    const valid = scoreReceipts([row], sha)[0]!;
    expect(valid.evaluated).toBe(1);
    expect(valid.split).toBe("held-out");
    expect(valid.completeFixtureCoverage).toBe(false);
    expect(valid.targetPrecision).toBe(1);
    expect(valid.allCalls).toBe(2);
    expect(valid.nonClassificationCalls).toBe(1);
    expect(valid.billedCostUsd).toBeNull();
    expect(valid.inputTokens).toBe(30);
    expect(valid.adoptionVeto).toBe(false);
    const wrong = scoreReceipts([{ ...row, target: "projects/active/invented.md" }], sha)[0]!;
    expect(wrong.targetPrecision).toBe(0);
    expect(wrong.adoptionVeto).toBe(true);
    const mislabeledKeep = scoreReceipts([{ ...row, predicted: "keep", target: null }], sha)[0]!;
    expect(mislabeledKeep.rejectedProposals).toBe(0);
    expect(mislabeledKeep.unsafeAccepted).toBe(1);
    expect(mislabeledKeep.adoptionVeto).toBe(true);
    expect(scoreReceipts([row, { ...row, cache: "warm" }], sha)).toHaveLength(2);
    expect(() => scoreReceipts([row, row], sha)).toThrow("duplicate receipt");
    expect(() => scoreReceipts([row], "0".repeat(64))).toThrow("fixture checksum mismatch");
  } finally { p.close(); }
});
