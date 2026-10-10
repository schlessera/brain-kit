// Shipped hygiene behaviour the mechanical-hygiene eval first exercised
// (#1386 split these from the prototype tests): the real `hygiene reconcile`
// CLI dry run, `reconcile` retaining entries behind failed checks, an
// unparseable log stopping reconciliation, and a manual snooze surviving a
// repair and reconciliation. The fixture brains under
// tests/fixtures/mechanical-hygiene/ only stage them.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtures, prepare, snapshot, NOW } from "./fixtures/mechanical-hygiene/prepare";
import { hygieneId, readHygieneLog, reconcile } from "../packages/core/src/lib/hygiene";
import { runCli } from "../packages/core/tests/cli-harness";

describe("mechanical hygiene offline runtime", () => {
  test("the real reconcile CLI detects the row and dry-run writes no markdown", async () => {
    const env = prepare(fixtures.singleStatusColumn);
    try {
      writeFileSync(join(env.root, "brain.config.json"), JSON.stringify({ reranker: { enabled: false } }));
      const before = snapshot(env.root, env.brain.taxonomy);
      const result = await runCli(env.root, ["hygiene", "reconcile", "--dry-run", "--json"]);
      expect(result.code).toBe(0);
      const envelope = JSON.parse(result.stdout);
      expect(envelope.detected.filter((c: { category: string }) => c.category === "index-lag")).toHaveLength(1);
      expect(snapshot(env.root, env.brain.taxonomy)).toEqual(before);
    } finally { env.close(); }
  });

  test("failedChecks preserves a not-redetected manual log entry", () => {
    const env = prepare(fixtures.datesInverted);
    try {
      const candidate = { category: "module-hygiene", path: "context/raft.md", evidence: "fixture", message: "Review the rigging" };
      reconcile(env.root, [candidate], new Map(), { now: NOW });
      reconcile(env.root, [], new Map(), { now: NOW, failedChecks: ["fixture-module"] });
      expect(readHygieneLog(env.root).find(e => e.id === hygieneId(candidate.category, candidate.path, candidate.evidence))?.state).toBe("open");
    } finally { env.close(); }
  });

  test("an unparseable existing log stops reconciliation and is left as written", async () => {
    const env = prepare(fixtures.datesInverted);
    try {
      mkdirSync(join(env.root, "context/hygiene"), { recursive: true });
      writeFileSync(join(env.root, "context/hygiene/open.md"), "---\ntype: context\ntitle: Open\n");
      let error: unknown;
      try { await env.reconcileOnce(); } catch (failure) { error = failure; }
      expect(String(error)).toContain("frontmatter is never closed");
      expect(readFileSync(join(env.root, "context/hygiene/open.md"), "utf8")).toBe("---\ntype: context\ntitle: Open\n");
    } finally { env.close(); }
  });

  test("manual snooze survives a mechanical repair and reconciliation", async () => {
    const fixture = fixtures.datesInverted;
    const env = prepare(fixture);
    try {
      const candidate = { category: "verify", path: "context/raft.md", evidence: "", message: "Verify the rope" };
      const id = hygieneId(candidate.category, candidate.path, candidate.evidence);
      mkdirSync(join(env.root, "context/hygiene"), { recursive: true });
      writeFileSync(join(env.root, "context/hygiene/snoozed.md"), `---\ntype: context\ntitle: Snoozed\ncreated: 2026-07-01\nupdated: 2026-07-01\n---\n\n## Snoozed\n\n### ${id}\n- until: 2026-08-01\n- note: wait for shore\n`);
      for (const [path, raw] of Object.entries(fixture.repaired)) writeFileSync(join(env.root, path), raw);
      await env.reconcileOnce(Object.keys(fixture.repaired).map(path => ({ path, fix: "Mechanical date repair" })));
      const entry = readHygieneLog(env.root).find(e => e.id === id);
      expect(entry?.state).toBe("snoozed");
      expect(entry?.until).toBe("2026-08-01");
      expect(readFileSync(join(env.root, "context/hygiene/snoozed.md"), "utf8")).toContain("wait for shore");
    } finally { env.close(); }
  });
});
