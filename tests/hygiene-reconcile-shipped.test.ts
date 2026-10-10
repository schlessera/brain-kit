// Shipped hygiene behaviour the mechanical-hygiene eval first exercised
// (#1386 split these from the prototype tests in
// experiments/mechanical-hygiene-eval.test.ts): the real `hygiene reconcile`
// CLI dry run, `reconcile` retaining entries behind failed checks, an
// unparseable log stopping repair, and a manual snooze surviving
// reconciliation. The eval's fixture brain and cycle only drive them.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apply, capture, plan } from "../scripts/evals/mechanical-hygiene/prototype";
import { cycle, fixtures, prepare, snapshot, TODAY } from "../scripts/evals/mechanical-hygiene/fixture";
import { hygieneId, readHygieneLog, reconcile } from "../packages/core/src/lib/hygiene";
import { runCli } from "../packages/core/tests/cli-harness";

describe("mechanical hygiene offline runtime", () => {
  test("the real reconcile CLI detects the row and dry-run writes no markdown", async () => {
    const env = prepare(fixtures.find(f => f.id === "single-status-column")!);
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

  test("failedChecks prevents repair and preserves a not-redetected manual log entry", async () => {
    const env = prepare(fixtures[0]);
    try {
      const candidate = { category: "module-hygiene", path: "context/raft.md", evidence: "fixture", message: "Review the rigging" };
      const now = new Date("2026-07-12T12:00:00Z");
      reconcile(env.root, [candidate], new Map(), { now });
      const detection = { candidates: [], failedChecks: ["fixture-module"] };
      const proposal = plan(capture(env.root, env.brain.taxonomy), env.brain.taxonomy, detection, TODAY);
      const current = snapshot(env.root, env.brain.taxonomy);
      expect(apply(env.root, proposal).written).toEqual([]);
      expect(snapshot(env.root, env.brain.taxonomy)).toEqual(current);
      reconcile(env.root, [], new Map(), { now, failedChecks: detection.failedChecks });
      expect(readHygieneLog(env.root).find(e => e.id === hygieneId(candidate.category, candidate.path, candidate.evidence))?.state).toBe("open");
    } finally { env.close(); }
  });

  test("an unparseable existing log prevents all content repair", async () => {
    const env = prepare(fixtures[0]);
    try {
      mkdirSync(join(env.root, "context/hygiene"), { recursive: true });
      writeFileSync(join(env.root, "context/hygiene/open.md"), "---\ntype: context\ntitle: Open\n");
      const before = readFileSync(join(env.root, "context/raft.md"), "utf8");
      let error: unknown;
      try { await cycle(env); } catch (failure) { error = failure; }
      expect(readFileSync(join(env.root, "context/raft.md"), "utf8")).toBe(before);
      expect(String(error)).toContain("frontmatter is never closed");
      expect(readFileSync(join(env.root, "context/hygiene/open.md"), "utf8")).toBe("---\ntype: context\ntitle: Open\n");
    } finally { env.close(); }
  });

  test("manual snooze survives a mechanical repair and reconciliation", async () => {
    const env = prepare(fixtures[0]);
    try {
      const candidate = { category: "verify", path: "context/raft.md", evidence: "", message: "Verify the rope" };
      const id = hygieneId(candidate.category, candidate.path, candidate.evidence);
      mkdirSync(join(env.root, "context/hygiene"), { recursive: true });
      writeFileSync(join(env.root, "context/hygiene/snoozed.md"), `---\ntype: context\ntitle: Snoozed\ncreated: 2026-07-01\nupdated: 2026-07-01\n---\n\n## Snoozed\n\n### ${id}\n- until: 2026-08-01\n- note: wait for shore\n`);
      await cycle(env);
      const entry = readHygieneLog(env.root).find(e => e.id === id);
      expect(entry?.state).toBe("snoozed");
      expect(entry?.until).toBe("2026-08-01");
      expect(readFileSync(join(env.root, "context/hygiene/snoozed.md"), "utf8")).toContain("wait for shore");
    } finally { env.close(); }
  });
});
