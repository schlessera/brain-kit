import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, renameSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apply, capture, plan } from "../scripts/evals/mechanical-hygiene/prototype";
import { cycle, fixtures, prepare, snapshot, TODAY } from "../scripts/evals/mechanical-hygiene/fixture";
import { hygieneId, readHygieneLog, reconcile } from "../packages/core/src/lib/hygiene";
import { keylessEnv, runCli } from "../packages/core/tests/cli-harness";

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

  test.each(["UTC", "Pacific/Honolulu", "Pacific/Kiritimati"])("date-only mtime repair is byte-identical in %s", async timezone => {
    const env = prepare(fixtures[0]);
    try {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "../scripts/evals/mechanical-hygiene/run.ts"), "--timezone-probe"], {
        env: { ...keylessEnv(env.root), TZ: timezone }, stdout: "pipe", stderr: "pipe", stdin: "ignore",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout.trim()).toBe(fixtures[0].expected["context/raft.md"].trim());
    } finally { env.close(); }
  });
  test.each(fixtures)("$id: exact content diff", async fixture => {
    const env = prepare(fixture);
    try {
      const initial = snapshot(env.root, env.brain.taxonomy);
      const dry = await cycle(env, true);
      expect(snapshot(env.root, env.brain.taxonomy)).toEqual(initial);
      expect(dry.applied.written).toEqual([]);
      const result = await cycle(env);
      expect(result.applied.error).toBeUndefined();
      expect(result.applied.stale).toEqual([]);
      const expectedPaths = Object.keys(fixture.files).filter(p => fixture.files[p] !== fixture.expected[p]);
      for (const [path, expected] of Object.entries(fixture.expected)) {
        // The protected occurrence is a real file write, with a nonempty body and expected output.
        expect(expected.length).toBeGreaterThan(50);
        expect(readFileSync(join(env.root, path), "utf8")).toBe(expected);
        if (!expectedPaths.includes(path)) expect(statSync(join(env.root, path)).mtimeMs).toBe(initial[path].mtimeMs);
      }
      expect(result.applied.written.sort()).toEqual(expectedPaths.sort());
      const once = snapshot(env.root, env.brain.taxonomy);
      const second = await cycle(env);
      expect(second.applied.written).toEqual([]);
      expect(second.log.changedFiles).toEqual([]);
      expect(snapshot(env.root, env.brain.taxonomy)).toEqual(once);
    } finally { env.close(); }
  });

  test("date and eligible table fixtures exercise nonempty plans and live detection", async () => {
    for (const id of ["date-mtime-later", "single-status-column"]) {
      const env = prepare(fixtures.find(f => f.id === id)!);
      try {
        const result = await cycle(env, true);
        expect(result.proposal.edits).toHaveLength(1);
        if (id === "single-status-column") {
          expect(result.detection.candidates.filter(c => c.category === "index-lag")).toHaveLength(1);
          expect((await cycle(env)).after.candidates.filter(c => c.category === "index-lag")).toEqual([]);
        } else {
          expect(result.detection.candidates.some(c => c.category === "date-order")).toBe(false);
        }
      } finally { env.close(); }
    }
  });

  test.each(["index", "detail", "mtime"])("%s changed after detection: no content writes", async change => {
    const env = prepare(fixtures.find(f => f.id === "single-status-column")!);
    try {
      const detected = await env.detect();
      const inputs = capture(env.root, env.brain.taxonomy);
      const proposal = plan(inputs, env.brain.taxonomy, detected, TODAY);
      expect(proposal.edits).toHaveLength(1);
      const path = join(env.root, change === "detail" ? "context/raft.md" : "context/_index.md");
      if (change === "mtime") utimesSync(path, new Date("2026-07-13"), new Date("2026-07-13"));
      else writeFileSync(path, readFileSync(path, "utf8") + "\nA new human note.\n");
      const current = snapshot(env.root, env.brain.taxonomy);
      const applied = apply(env.root, proposal);
      expect(snapshot(env.root, env.brain.taxonomy)).toEqual(current);
      expect(applied.written).toEqual([]);
      expect(applied.stale).toHaveLength(1);
    } finally { env.close(); }
  });

  test("one stale file vetoes a batch before an earlier eligible write", async () => {
    const fixture = fixtures.find(f => f.id === "date-mtime-later")!;
    const env = prepare({ ...fixture, files: { "context/a.md": fixture.files["context/raft.md"], "context/z.md": fixture.files["context/raft.md"] } });
    try {
      const proposal = plan(capture(env.root, env.brain.taxonomy), env.brain.taxonomy, await env.detect(), TODAY);
      expect(proposal.edits).toHaveLength(2);
      writeFileSync(join(env.root, "context/z.md"), "A new human document.\n");
      const current = snapshot(env.root, env.brain.taxonomy);
      expect(apply(env.root, proposal).written).toEqual([]);
      expect(snapshot(env.root, env.brain.taxonomy)).toEqual(current);
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

  test.each(["file", "parent"])("a replaced symlink %s cannot become a write target", async kind => {
    const env = prepare(fixtures[0]);
    try {
      const proposal = plan(capture(env.root, env.brain.taxonomy), env.brain.taxonomy, await env.detect(), TODAY);
      expect(proposal.edits).toHaveLength(1);
      const path = join(env.root, kind === "file" ? "context/raft.md" : "context");
      const moved = join(env.root, kind === "file" ? "retained.txt" : "retained");
      renameSync(path, moved); symlinkSync(moved, path);
      const original = kind === "file" ? moved : join(moved, "raft.md");
      const before = readFileSync(original, "utf8");
      const applied = apply(env.root, proposal);
      expect(readFileSync(original, "utf8")).toBe(before);
      expect(applied.written).toEqual([]);
      expect(applied.stale).toHaveLength(1);
    } finally { env.close(); }
  });
});
