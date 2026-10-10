import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { audit, findFactDrift, loadAuditDocs } from "../src/lib/auditor";
import { brainConfigSchema } from "../src/lib/config";
import { openDatabase } from "../src/lib/db";
import { indexAll } from "../src/lib/indexer";
import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
import { buildTaxonomy } from "../src/lib/taxonomy";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const SOURCE = "me/anchor.md";
const RESTATEMENT = "notes/raft-ledger.md";
const NOW = new Date("2026-07-12T00:00:00Z");
const roots: string[] = [];
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) cleanup(root);
});

interface FixtureDoc { path: string; body: string; metadata?: string }

async function fixture(canonical: string, found: string, extra: FixtureDoc[] = []) {
  const root = makeTempBrain({ empty: true });
  roots.push(root);
  const db = openDatabase(":memory:");
  databases.push(db);
  const config = brainConfigSchema.parse({ taxonomy: { facts: {
    count: { source: SOURCE, patterns: ["Count=([^\\n]*)"] },
    length: { source: SOURCE, patterns: ["Length=([^\\n]*)"] },
  } } });
  writeFileSync(join(root, "brain.config.ts"), `export default ${JSON.stringify(config)};\n`);
  const taxonomy = buildTaxonomy({ user: config });
  const documents: FixtureDoc[] = [
    { path: SOURCE, metadata: `facts: { count: ${JSON.stringify(canonical)}, length: "1" }\n`, body: "Count=999\nCanonical raft ledger.\n" },
    { path: RESTATEMENT, body: `Count=${found}\nFictional raft measurement; exact-value regression fixture.\n` },
    ...extra,
  ];
  for (const doc of documents) {
    const path = join(root, doc.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `---\ntype: ${doc.path === SOURCE ? "identity" : "note"}\ntitle: ${doc.path}\ncreated: 2026-07-12\nupdated: 2026-07-12\n${doc.metadata ?? ""}---\n\n${doc.body}`);
  }
  const before = documents.map(doc => readFileSync(join(root, doc.path), "utf8"));
  const parsed = parseFrontmatter(before[0]!).data;
  expect(parsed.facts.count).toBe(canonical);
  expect(typeof parsed.facts.count).toBe("string");
  await indexAll(db, { root, taxonomy, quiet: true });
  const indexed = loadAuditDocs(db);
  expect(indexed).toHaveLength(documents.length);
  expect(indexed.find(doc => doc.path === RESTATEMENT)?.content).toContain(`Count=${found}`);
  return { root, db, taxonomy, indexed, unchanged: () => {
    expect(documents.map(doc => readFileSync(join(root, doc.path), "utf8"))).toEqual(before);
  } };
}

const different: Array<[string, string, string]> = [
  ["adjacent unsafe integers", "9007199254740992", "9007199254740993"],
  ["precise fractional values", "1.00000000000000001", "1.00000000000000002"],
  ["negative unsafe integers", "-9007199254740992", "-9007199254740993"],
  ["large fractional values", "9007199254740992.1", "9007199254740992.2"],
  ["exponent-spelled precise values", "100000000000000001e-17", "1.00000000000000002"],
  ["noncollapsing positive control", "9007199254740992", "9007199254740994"],
  ["different exponents", "1e1", "1e2"],
  ["different signs", "-1", "+1"],
  ["underflow versus zero", "1e-999", "0"],
  ["different underflows", "1e-999", "2e-999"],
  ["huge negative exponents", "1e-999999999999999999999999999999", "2e-999999999999999999999999999999"],
  ["adjacent hexadecimal integers", "0x20000000000000", "0x20000000000001"],
  ["adjacent binary integers", "0b100000000000000000000000000000000000000000000000000000", "0b100000000000000000000000000000000000000000000000000001"],
  ["adjacent octal integers", "0o400000000000000000", "0o400000000000000001"],
];

const equivalent: Array<[string, string, string]> = [
  ["trailing fractional zeros", "12.5", "12.500"],
  ["decimal leading zeros", "0012.50", "12.5"],
  ["whitespace and positive sign", "12.5", " \t+12.500\t "],
  ["negative sign", "-12.5", "-125e-1"],
  ["leading decimal point", ".5", "5e-1"],
  ["trailing decimal point", "12.", "1.2e1"],
  ["upper-case signed exponent", "1.25E+02", "125"],
  ["leading exponent zeros", "1e+0002", "100"],
  ["large exact integer", "9007199254740993", "9007199254740993.000"],
  ["large exact decimal", "9007199254740993.125", "9007199254740993125e-3"],
  ["hexadecimal", "0X20000000000001", "9007199254740993"],
  ["binary", "0B100000000000000000000000000000000000000000000000000001", "9007199254740993"],
  ["octal", "0O400000000000000001", "9007199254740993"],
  ["base-prefixed trailing decimal zeros", "0x64", "1e2"],
  ["signed zero", "-0", "+0.00"],
  ["zero with huge positive exponent", "0e999999999999999999999999999999", "0"],
  ["equivalent underflow", "1e-999", "10e-1000"],
  ["equivalent huge negative exponent", "1e-999999999999999999999999999999", "10e-1000000000000000000000000000000"],
];

describe("exact keyed fact values through indexed detection and audit", () => {
  for (const [label, canonical, found] of different) {
    test(`reports ${label} with original exact strings`, async () => {
      const f = await fixture(canonical, found);
      expect(findFactDrift(f.indexed, f.taxonomy, f.root).map(({ doc, ...values }) => ({ path: doc.path, ...values })))
        .toEqual([{ path: RESTATEMENT, key: "count", found, canonical, source: SOURCE }]);
      expect(audit(f.db, f.taxonomy, { root: f.root, now: NOW }).filter(i => i.category === "fact-drift"))
        .toEqual([{ path: RESTATEMENT, severity: "warning", category: "fact-drift",
          message: `count: found ${found}, canonical ${canonical}`,
          suggestion: `Update it to match ${SOURCE}, or add count to facts_ignore if it is right as a record of the past` }]);
      f.unchanged();
    });
  }
  for (const [label, canonical, found] of equivalent) {
    test(`preserves ${label} equivalence`, async () => {
      const f = await fixture(canonical, found);
      expect(findFactDrift(f.indexed, f.taxonomy, f.root)).toEqual([]);
      expect(audit(f.db, f.taxonomy, { root: f.root, now: NOW }).filter(i => i.category === "fact-drift")).toEqual([]);
      f.unchanged();
    });
  }
  for (const [label, canonical, found, equal] of [
    ["empty capture", "0", "", false],
    ["text whitespace", "Raft", "  Raft  ", true],
    ["text case", "Raft", "raft", false],
    ["numeric separator", "1000", "1_000", false],
    ["bigint suffix", "1", "1n", false],
    ["signed hexadecimal", "1", "+0x1", false],
    ["negative hexadecimal", "-1", "-0x1", false],
    ["Infinity is text", "Infinity", "+Infinity", false],
    ["identical infinity", "Infinity", "Infinity", true],
    ["identical NaN", "NaN", "NaN", true],
    ["overflow spellings stay textual", "1e309", "10e308", false],
  ] as const) {
    test(`keeps the existing nonnumeric boundary: ${label}`, async () => {
      const f = await fixture(canonical, found);
      const drift = findFactDrift(f.indexed, f.taxonomy, f.root);
      expect(drift.map(d => [d.found, d.canonical])).toEqual(equal ? [] : [[found.trim(), canonical.trim()]]);
      f.unchanged();
    });
  }

  test("retains source, archived, code and per-key ignore exclusions with a real positive control", async () => {
    const found = "9007199254740993";
    const f = await fixture("9007199254740992", found, [
      { path: "notes/archived.md", metadata: "status: archived\n", body: `Count=${found}\n` },
      { path: "notes/inline.md", body: `Example \`Count=${found}\`\n` },
      { path: "notes/fenced.md", body: `\`\`\`text\nCount=${found}\n\`\`\`\n` },
      { path: "notes/indented.md", body: `    Count=${found}\n` },
      { path: "notes/retrospective.md", metadata: "facts_ignore: [count]\n", body: `Count=${found}\nLength=2\n` },
    ]);
    const drift = findFactDrift(f.indexed, f.taxonomy, f.root);
    expect(drift.map(d => [d.doc.path, d.key, d.found])).toEqual([
      [RESTATEMENT, "count", found], ["notes/retrospective.md", "length", "2"],
    ]);
    expect(audit(f.db, f.taxonomy, { root: f.root, now: NOW }).filter(i => i.category === "fact-drift")).toHaveLength(2);
    f.unchanged();
  });

  for (const [label, canonical, found, equal] of [
    ["adjacent integers", "9007199254740992", "9007199254740993", false],
    ["precise decimals", "1.00000000000000001", "1.00000000000000002", false],
    ["equivalent large values", "9007199254740993", "+9007199254740993.00", true],
    ["noncollapsing positive control", "9007199254740992", "9007199254740994", false],
  ] as const) test(`real CLI JSON audit preserves ${label} and its envelope`, async () => {
    const f = await fixture(canonical, found);
    const indexed = await runCli(f.root, ["index", "--json"]);
    expect(indexed.code).toBe(0);
    const result = await runCli(f.root, ["audit", "--json"]);
    expect(result.code).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.issues.filter((i: { category: string }) => i.category === "fact-drift")).toEqual(equal ? [] : [
      { path: RESTATEMENT, severity: "warning", category: "fact-drift",
        message: `count: found ${found}, canonical ${canonical}`,
        suggestion: `Update it to match ${SOURCE}, or add count to facts_ignore if it is right as a record of the past` },
    ]);
    expect(Object.keys(out).sort()).toEqual(["errors", "informational", "infos", "issues", "mustFix", "warnings"]);
    if (!equal) expect(out.warnings).toBeGreaterThan(0);
    expect(out.mustFix).toBe(out.errors + out.warnings);
    expect(out.informational).toBe(out.infos);
    f.unchanged();
  });
});
