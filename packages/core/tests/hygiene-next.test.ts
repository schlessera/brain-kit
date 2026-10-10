import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { canonicalFindings, hygieneId, readHygieneLog, reconcile, type HygieneCandidate } from "../src/lib/hygiene";
import { reviewUrgency, selectHygieneNext } from "../src/lib/hygiene-next";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const NOW = new Date("2026-07-12T12:00:00Z");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) cleanup(root); });
function root() { const r = makeTempBrain({ empty: true }); roots.push(r); return r; }
function candidate(evidence: string, severity: "error" | "warning" | "info" = "warning", urgency?: string): HygieneCandidate {
  return { category: severity === "info" ? "todo" : "broken-link", path: "journeys/return-to-ithaca.md", evidence,
    message: "Odysseus reviews the route", source: { source: "audit", name: "broken-link", severity }, urgency };
}
const id = (c: HygieneCandidate) => hygieneId(c.category, c.path, c.evidence);
function next(r: string, candidates: HygieneCandidate[], now = NOW) {
  reconcile(r, candidates, new Map(), { now });
  return selectHygieneNext(r, canonicalFindings(candidates), readHygieneLog(r), now);
}
function dispose(r: string, candidates: HygieneCandidate[], c: HygieneCandidate, until?: string) {
  const fingerprint = canonicalFindings(candidates).get(id(c))!.fingerprint;
  reconcile(r, candidates, new Map(), { now: NOW, dispositions: [until
    ? { kind: "snoozed", id: id(c), expectFingerprint: fingerprint, until }
    : { kind: "dismissed", id: id(c), expectFingerprint: fingerprint }] });
}

describe("hygiene next priority and eligibility", () => {
  test("validation error, warning, due snooze and future snooze walk the backlog; markers stay informational", () => {
    const r = root();
    const error: HygieneCandidate = { ...candidate("title", "error"), category: "required-field",
      source: { source: "validation", name: "required-missing", severity: "error" } };
    const warning = candidate("Eumaeus hut");
    const due = candidate("Circe palace", "warning", "due");
    const future = candidate("Aeolus island", "warning", "immediate");
    const info = candidate("TODO", "info");
    const candidates = [future, info, due, warning, error];
    next(r, candidates);
    dispose(r, candidates, due, "2026-07-12T11:00:00Z");
    dispose(r, candidates, future, "2026-07-13T08:00:00Z");
    const first = next(r, candidates);
    expect(first.finding?.id).toBe(id(error));
    expect(first.finding?.sources).toEqual([{ source: "validation", name: "required-missing", severity: "error" }]);
    expect(first.counts).toEqual({ eligibleRemaining: 3, fixed: 0, dismissed: 0, snoozed: 1,
      nextSnoozeDueAt: "2026-07-13T08:00:00Z", informationalNotShown: 1 });
    dispose(r, candidates, error);
    expect(next(r, candidates).finding?.id).toBe(id(due));
    dispose(r, candidates, due);
    expect(next(r, candidates).finding?.id).toBe(id(warning));
    dispose(r, candidates, warning);
    expect(next(r, candidates)).toEqual({ finding: null, counts: { eligibleRemaining: 0, fixed: 0, dismissed: 3,
      snoozed: 1, nextSnoozeDueAt: "2026-07-13T08:00:00Z", informationalNotShown: 1 } });
    expect(next(r, candidates, new Date("2026-07-13T08:00:01Z")).finding?.id).toBe(id(future));
    expect(next(r, candidates.filter((c) => c !== future)).counts.fixed).toBe(1);
  });

  test("equal rank chooses age before identity and counts newer peers", () => {
    const r = root();
    const candidates = [candidate("Eumaeus hut"), candidate("Circe palace")].sort((a, b) => id(a) < id(b) ? -1 : 1);
    const older = candidates[1];
    next(r, [older], new Date("2026-07-01T12:00:00Z"));
    const result = next(r, candidates);
    expect(result.finding?.id).toBe(id(older));
    expect(result.finding?.priorityReason).toEqual({ severity: "warning", urgency: "unknown", ageDays: 11,
      newerWithSameRank: 1, tieBreak: "age" });
  });

  test("equal rank and equal age chooses lower canonical ID regardless of enumeration", () => {
    const r = root();
    const candidates = [candidate("Eumaeus hut"), candidate("Circe palace")].sort((a, b) => id(a) < id(b) ? 1 : -1);
    const result = next(r, candidates);
    expect(result.finding?.id).toBe(id(candidates[1]));
    expect(result.finding?.priorityReason.tieBreak).toBe("identity");
    expect(next(r, [...candidates].reverse()).finding).toEqual(result.finding);
  });

  test("missing urgency is the literal unknown; known urgency precedes age within severity", () => {
    const r = root();
    const unknown = candidate("Eumaeus hut");
    expect(next(r, [unknown]).finding?.priorityReason.urgency).toBe("unknown");
    const due = candidate("Circe palace", "warning", "due");
    const result = next(r, [unknown, due]);
    expect(result.finding?.id).toBe(id(due));
    expect(result.finding?.priorityReason.tieBreak).toBe("urgency");
    expect(reviewUrgency("constructor")).toBe("unknown");
    expect(reviewUrgency("arbitrary")).toBe("unknown");
    expect(reviewUrgency("upcoming\noverdue")).toBe("overdue");
  });

  test("future snooze is excluded until its exact instant; unchanged dismissal and resolved finding stay excluded", () => {
    const r = root();
    const future = candidate("Eumaeus hut");
    const dismissed = candidate("Circe palace");
    const resolved = candidate("Aeolus island");
    const candidates = [future, dismissed, resolved];
    next(r, candidates);
    dispose(r, candidates, future, "2026-07-12T12:01:00Z");
    dispose(r, candidates, dismissed);
    const remaining = [future, dismissed];
    expect(next(r, remaining).finding).toBeNull();
    expect(next(r, remaining, new Date("2026-07-12T12:00:59Z")).finding).toBeNull();
    expect(next(r, remaining, new Date("2026-07-12T12:01:00Z")).finding?.id).toBe(id(future));
  });

  test("changed evidence returns a snoozed finding with its invalidation reason", () => {
    const r = root();
    const c = candidate("Eumaeus hut");
    next(r, [c]);
    dispose(r, [c], c, "2026-07-13T08:00:00Z");
    const changed = { ...c, urgency: "due" };
    const result = next(r, [changed]);
    expect(result.finding?.id).toBe(id(c));
    expect(result.finding?.invalidation?.changed).toEqual(["urgency"]);
    expect(result.finding?.invalidation?.disposition).toBe("snoozed");
  });

  test("presentation gives a contained file line, bounded excerpt and field; unavailable evidence stays null", () => {
    const r = root();
    mkdirSync(join(r, "journeys"));
    writeFileSync(join(r, "journeys/return-to-ithaca.md"), "# Return to Ithaca\n" + "Odysseus crosses the sea. ".repeat(6) + "[[Eumaeus hut]] before sunset. " + "Odysseus continues the journey. ".repeat(5) + "\n");
    const c = candidate("Eumaeus hut");
    const finding = next(r, [c]).finding!;
    expect(finding.line).toBe(2);
    expect(finding.excerpt).toContain("[[Eumaeus hut]]");
    expect([...finding.excerpt!].length).toBeLessThanOrEqual(60);
    expect(finding.handler).toBe("manual");
    expect(finding.title).toBe("A link points to a note that does not exist");
    const field = { ...candidate("title", "error"), category: "required-field" };
    expect(next(r, [field]).finding).toMatchObject({ field: "title", line: null, excerpt: null });
    // An extra candidate must not cause an arbitrary filesystem read.
    const outside = root();
    writeFileSync(join(outside, "outside.md"), "Odysseus visits [[Eumaeus hut]] beyond this fixture root.");
    symlinkSync(join(outside, "outside.md"), join(r, "escape.md"));
    expect(next(r, [{ ...c, path: "escape.md" }]).finding?.excerpt).toBeNull();
  });
});

// Raw-byte receipts include the disposable DB: config blockers must return
// before the indexing/reconciliation path, not merely before its final write.
function snapshot(r: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const path = join(dir, e.name), name = prefix + e.name;
      if (e.isDirectory()) walk(path, name + "/");
      else out[name] = readFileSync(path).toString("base64");
    }
  };
  walk(r, "");
  return out;
}

describe("hygiene next real CLI", () => {
  test("invalid config returns a structured blocker and preserves existing hygiene and database bytes", async () => {
    const r = root();
    writeFileSync(join(r, "brain.config.json"), JSON.stringify({ schemaa: 1 }));
    writeFileSync(join(r, "brain.db"), "disposable fixture database");
    mkdirSync(join(r, "context/hygiene"), { recursive: true });
    writeFileSync(join(r, "context/hygiene/open.md"), "existing log bytes\n");
    const before = snapshot(r);
    const result = await runCli(r, ["hygiene", "next", "--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout || "null")).toEqual({ blocker: { kind: "configuration", message: expect.stringContaining("schemaa"),
      path: join(r, "brain.config.json"), line: null, column: null } });
    expect(snapshot(r)).toEqual(before);
    for (const sub of ["reconcile", "dismiss", "snooze", "list"]) {
      const refused = await runCli(r, ["hygiene", sub, "--json"]);
      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe("");
      expect(snapshot(r)).toEqual(before);
    }
  });

  test("invalid config on an empty log never creates context/hygiene", async () => {
    const r = root();
    writeFileSync(join(r, "brain.config.json"), "{");
    const result = await runCli(r, ["hygiene", "next", "--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).blocker.kind).toBe("configuration");
    expect(existsSync(join(r, "context/hygiene"))).toBe(false);
    expect(existsSync(join(r, "brain.db"))).toBe(false);
  });

  test("valid empty backlog succeeds with no finding and explicit end-state counts", async () => {
    const r = root();
    writeFileSync(join(r, "brain.config.json"), "{}");
    const result = await runCli(r, ["hygiene", "next", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ finding: null, counts: { eligibleRemaining: 0, fixed: 0,
      dismissed: 0, snoozed: 0, nextSnoozeDueAt: null, informationalNotShown: 0 } });
  });

  test("real validation join selects a missing title, retains two broken-link sources, then advances after dismiss", async () => {
    const r = root();
    writeFileSync(join(r, "brain.config.json"), "{}");
    mkdirSync(join(r, "notes"));
    const doc = "---\ntype: note\ncreated: 2026-07-12\nupdated: 2026-07-12\ntags: []\n---\nOdysseus plans the return.\n";
    writeFileSync(join(r, "notes/return-to-ithaca.md"), doc);
    writeFileSync(join(r, "notes/route.md"), doc.replace("type: note", "type: note\ntitle: Return route").replace("Odysseus plans the return.", "Odysseus visits [[Eumaeus hut]]."));
    const result = await runCli(r, ["hygiene", "next", "--json"]);
    expect(result.code).toBe(0);
    const first = JSON.parse(result.stdout).finding;
    expect(first).toMatchObject({ id: hygieneId("required-field", "notes/return-to-ithaca.md", "title"), field: "title",
      priorityReason: { severity: "error", urgency: "unknown" } });
    const dismiss = await runCli(r, ["hygiene", "dismiss", first.id, "--expect-fingerprint", first.fingerprint, "--json"]);
    expect(dismiss.code).toBe(0);
    const secondResult = await runCli(r, ["hygiene", "next", "--json"]);
    expect(secondResult.code).toBe(0);
    const second = JSON.parse(secondResult.stdout).finding;
    expect(second.id).toBe(hygieneId("broken-link", "notes/route.md", "Eumaeus hut"));
    expect(second.sources).toHaveLength(2);
    expect(second.line).toBe(8);
    expect(second.excerpt).toContain("[[Eumaeus hut]]");
  });

  test("unavailable module check returns a blocker rather than an empty backlog", async () => {
    const r = root();
    mkdirSync(join(r, "modules/navigation"), { recursive: true });
    writeFileSync(join(r, "modules/navigation/module.ts"), `
      import { defineModule } from "@schlessera/brain";
      export default defineModule({ name: "navigation", setup: () => ({
        hygieneChecks: [() => { throw new Error("fixture check unavailable"); }],
      }) });
    `);
    writeFileSync(join(r, "brain.config.json"), JSON.stringify({ modules: { "./modules/navigation": {} } }));
    const result = await runCli(r, ["hygiene", "next", "--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ blocker: { kind: "checks", failedChecks: ["navigation"] } });
  });

  test("no configuration refuses the next indexing path", async () => {
    const r = root();
    for (const args of [["hygiene", "next", "--json"], ["hygiene", "--json", "next"], ["hygiene", "--json", "--", "next"]]) {
      const result = await runCli(r, args);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("No brain.config");
      expect(existsSync(join(r, "brain.db"))).toBe(false);
    }
  });
});
