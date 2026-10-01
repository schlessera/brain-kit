import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";

import type { AuditIssue } from "../src/lib/types";
import type { BrainStats } from "../src/lib/stats";
import type { ValidationIssue } from "../src/lib/validate";
import { openDatabase } from "../src/lib/db";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const SOURCE = "notes/anchor-test.md";
const SELF_TARGETS = ["#Section one", "#Section two", "#Missing heading"];
const BROKEN = "does-not-exist";

describe("same-document heading links over a real indexed corpus", () => {
  let root: string;
  let baseline: BrainStats;
  let stats: BrainStats;
  let issues: AuditIssue[];
  let validation: ValidationIssue[];
  let links: { target: string; targetPath: string | null }[];

  beforeAll(async () => {
    root = makeTempBrain();
    expect((await runCli(root, ["index", "--json"])).code).toBe(0);
    const before = await runCli(root, ["stats", "--json"]);
    expect(before.code).toBe(0);
    baseline = JSON.parse(before.stdout);

    writeFileSync(join(root, SOURCE), `---
title: Anchor test
type: note
status: active
---

## Section one

See [[#Section one]] above and [[#Section two|the next section]] below.

## Section two

Heading existence is not checked for [[#Missing heading]].
The broken-link control is [[${BROKEN}]].
`);
    expect((await runCli(root, ["index", "--json"])).code).toBe(0);
    const audited = await runCli(root, ["audit", "--json"]);
    const validated = await runCli(root, ["validate", "--json"]);
    const measured = await runCli(root, ["stats", "--json"]);
    expect(audited.code).toBe(0);
    expect(validated.code).toBe(0);
    expect(measured.code).toBe(0);
    issues = JSON.parse(audited.stdout).issues;
    validation = JSON.parse(validated.stdout).issues;
    stats = JSON.parse(measured.stdout);

    const db = openDatabase(join(root, "brain.db"), { readonly: true });
    try {
      links = db.prepare(`
        SELECT l.target, target.path AS targetPath
        FROM links l
        JOIN documents source ON source.id = l.source_id
        LEFT JOIN documents target ON target.id = l.target_id
        WHERE source.path = ? ORDER BY l.target
      `).all(SOURCE) as typeof links;
    } finally {
      db.close();
    }
  });

  afterAll(() => cleanup(root));

  test("audit reports the real broken link without self-heading warnings", () => {
    const broken = issues.filter((i) => i.category === "broken-link" && i.path === SOURCE);
    expect(broken.filter((i) => i.target === BROKEN)).toEqual([
      expect.objectContaining({ target: BROKEN, severity: "warning" }),
    ]);
    // This assertion must fail on the old resolver, independently of the
    // index/validate/stats assertions in the other tests.
    expect(broken.filter((i) => SELF_TARGETS.includes(i.target ?? ""))).toEqual([]);
    expect(broken).toHaveLength(1);
  });

  test("index records self-heading targets as the source document, including a pipe label", () => {
    expect(links.filter((l) => l.target === BROKEN)).toEqual([{ target: BROKEN, targetPath: null }]);
    expect(links.filter((l) => SELF_TARGETS.includes(l.target))).toEqual(
      [...SELF_TARGETS].sort().map((target) => ({ target, targetPath: SOURCE }))
    );
    expect(links).toHaveLength(4);
  });

  test("validate reports the real broken link without self-heading findings", () => {
    const unresolved = validation.filter((i) => i.file === SOURCE && i.message.includes("wiki-link:"));
    expect(unresolved.filter((i) => i.message.includes(`[[${BROKEN}]]`))).toEqual([
      expect.objectContaining({ level: "warning", message: `Unresolved wiki-link: [[${BROKEN}]]` }),
    ]);
    expect(unresolved.filter((i) => SELF_TARGETS.some((target) => i.message.includes(`[[${target}]]`)))).toEqual([]);
    expect(unresolved).toHaveLength(1);
  });

  test("stats counts only the real broken link in the count and rate", () => {
    expect(baseline.brokenLinks).toBeGreaterThan(0);
    expect(links.some((l) => l.target === BROKEN && l.targetPath === null)).toBe(true);
    expect(stats.brokenLinks).toBe(baseline.brokenLinks + 1);
    expect(stats.links).toBe(baseline.links + 4);
    expect(stats.health.brokenLinkRate).toBeCloseTo((baseline.brokenLinks + 1) / (baseline.links + 4), 10);
  });
});
