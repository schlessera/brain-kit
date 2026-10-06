/**
 * Hygiene review data (#1024): validation joined into hygiene detection, one
 * canonical finding per problem with its provenance, category evidence
 * fingerprints, and durable Dismiss/Snooze that only relevant evidence change
 * invalidates. Every row of the example table in
 * docs/decisions/hygiene-review.md ("Dismissal and snooze") is exercised
 * here, on the decision's own Odysseus example.
 *
 * Library tests drive `reconcile` with an injected clock; each call reads the
 * log back from disk, holding nothing in memory between runs. The CLI tests
 * run every step as a fresh `brain` process.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { loadAuditDocs } from "../src/lib/auditor";
import { brainConfigSchema } from "../src/lib/config";
import { openDatabase } from "../src/lib/db";
import {
  canonicalFindings,
  detectCandidates,
  HygieneRefusal,
  hygieneId,
  readHygieneLog,
  reconcile,
  type HygieneCandidate,
  type HygieneDispositionRequest,
  type ReconcileResult,
} from "../src/lib/hygiene";
import { indexAll } from "../src/lib/indexer";
import { buildTaxonomy } from "../src/lib/taxonomy";
import { validate } from "../src/lib/validate";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const DOC = "journeys/return-to-ithaca.md";
const NOW = new Date("2026-07-12T09:00:00Z");
const DAY = 86_400_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);
const taxonomy = buildTaxonomy({ user: brainConfigSchema.parse({ taxonomy: {} }) });

const BROKEN_ID = hygieneId("broken-link", DOC, "Eumaios hut");
const CHANGED_ID = hygieneId("broken-link", DOC, "Eumaeus hut");
const TITLE_ID = hygieneId("required-field", DOC, "title");

const roots: string[] = [];
afterAll(() => roots.forEach(cleanup));

/** The decision's example: a broken wiki-link, and (with `title: false`) a missing required field. */
function journey(opts: { target?: string; heading?: string; title?: boolean; label?: string } = {}): string {
  const { target = "Eumaios hut", heading = "The last leg", title = true, label } = opts;
  return [
    "---",
    ...(title ? ['title: "Return to Ithaca"'] : []),
    "type: note",
    "created: 2026-07-01",
    "updated: 2026-07-01",
    "tags: [voyage]",
    "---",
    "",
    `# ${heading}`,
    "",
    `Odysseus met the swineherd at [[${target}${label ? `|${label}` : ""}]] before going up to the palace.`,
    "",
  ].join("\n");
}

function brain(doc = journey()): string {
  const root = makeTempBrain({ empty: true });
  roots.push(root);
  writeFileSync(join(root, "brain.config.json"), JSON.stringify({ taxonomy: {} }));
  write(root, doc);
  return root;
}

function write(root: string, doc: string): void {
  mkdirSync(join(root, "journeys"), { recursive: true });
  writeFileSync(join(root, DOC), doc);
}

/** Index and detect, as `brain hygiene reconcile` does, with the given clock. */
async function detect(root: string, now = NOW) {
  const db = openDatabase(join(root, "brain.db"));
  try {
    await indexAll(db, { root, taxonomy, force: false, quiet: true });
    const detection = await detectCandidates(db, { taxonomy, root, modules: [] }, now);
    return { ...detection, docs: new Map(loadAuditDocs(db).map((d) => [d.path, d])) };
  } finally {
    db.close();
  }
}

async function run(root: string, now = NOW, dispositions: HygieneDispositionRequest[] = [], extra: HygieneCandidate[] = []): Promise<ReconcileResult> {
  const { candidates, failedChecks, docs } = await detect(root, now);
  return reconcile(root, candidates, docs, { now, failedChecks, dispositions, extra });
}

const finding = (result: ReconcileResult, id: string) => {
  const found = result.detected.find((d) => d.id === id);
  if (!found) throw new Error(`${id} not detected; detected: ${result.detected.map((d) => d.id).join(", ")}`);
  return found;
};
const entry = (root: string, id: string) => readHygieneLog(root).find((e) => e.id === id);
const stateOf = (root: string, id: string) => entry(root, id)?.state ?? null;

function hygieneFiles(root: string): Record<string, string> {
  const dir = join(root, "context/hygiene");
  return Object.fromEntries(readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name), "utf-8")]));
}

describe("canonical identity", () => {
  test("validation and audit reporting the same unresolved target are one finding with both sources", async () => {
    const root = brain();
    const result = await run(root);
    const broken = finding(result, BROKEN_ID);
    expect(broken.sources).toHaveLength(2);
    expect(broken.sources).toEqual([
      { source: "audit", name: "broken-link", severity: "warning" },
      { source: "validation", name: "link-unresolved", severity: "warning" },
    ]);
    expect(result.detected.filter((d) => d.category === "broken-link" && d.path === DOC)).toHaveLength(1);
    expect(entry(root, BROKEN_ID)).toMatchObject({ state: "open", sources: broken.sources, fingerprint: broken.fingerprint });
  });

  test("a broken link and a missing required field in one document are two findings; so are two broken targets", async () => {
    const root = brain(journey({ title: false }).replace("before going", "and [[Eumaeus hut]] before going"));
    const result = await run(root);
    const ids = result.detected.filter((d) => d.path === DOC && ["broken-link", "required-field"].includes(d.category)).map((d) => d.id);
    expect(ids.sort()).toEqual([BROKEN_ID, CHANGED_ID, TITLE_ID].sort());
    expect(finding(result, TITLE_ID).sources).toEqual([{ source: "validation", name: "required-missing", severity: "error" }]);
  });

  test("reversing the order the sources are enumerated in writes byte-identical logs with the same IDs", async () => {
    const forward = brain(journey().replace("created: 2026-07-01\n", ""));
    const backward = brain(journey().replace("created: 2026-07-01\n", ""));
    // A second source for the same broken link, worded differently, so the order could show.
    const skill: HygieneCandidate = {
      category: "broken-link", path: DOC, evidence: "Eumaios hut", message: "The hut link names no note",
      source: { source: "skill", name: "broken-link", severity: "warning" },
    };
    const a = await detect(forward);
    const b = await detect(backward);
    expect(a.candidates.filter((c) => c.category === "broken-link").length).toBeGreaterThanOrEqual(2);
    const first = reconcile(forward, [...a.candidates, skill], a.docs, { now: NOW });
    const second = reconcile(backward, [skill, ...b.candidates].reverse(), b.docs, { now: NOW });
    expect(second.detected).toEqual(first.detected);
    expect(finding(first, BROKEN_ID).sources).toHaveLength(3);
    expect(finding(first, hygieneId("required-field", DOC, "created")).sources).toEqual([
      { source: "validation", name: "required-missing", severity: "warning" },
    ]);
    expect(Object.keys(hygieneFiles(forward)).length).toBeGreaterThan(0);
    expect(hygieneFiles(backward)).toEqual(hygieneFiles(forward));
  });

  test("brain validate's own output keeps its three fields", () => {
    const root = brain(journey({ title: false }));
    const issues = validate(root, taxonomy);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) expect(Object.keys(issue)).toEqual(["file", "level", "message"]);
  });
});

describe("fingerprints", () => {
  const fingerprints = (candidates: HygieneCandidate[]) =>
    new Map([...canonicalFindings(candidates)].map(([id, f]) => [id, f.fingerprint]));
  const link = (over: Partial<HygieneCandidate> = {}): HygieneCandidate => ({
    category: "broken-link", path: DOC, evidence: "Eumaios hut", message: "Unresolved wiki-link: [[Eumaios hut]]",
    source: { source: "audit", name: "broken-link", severity: "warning" }, facts: { tokens: "[[Eumaios hut]]" }, ...over,
  });

  test("the message, line numbers and order do not enter it; tokens, severity and urgency do", () => {
    const base = fingerprints([link()]).get(BROKEN_ID);
    expect(base).toMatch(/^[0-9a-f]{12}$/);
    expect(fingerprints([link({ message: "Unresolved wiki-link: [[Eumaios hut]] (line 14)" })]).get(BROKEN_ID)).toBe(base);
    expect(fingerprints([link({ facts: { tokens: "[[Eumaios hut|the hut]]" } })]).get(BROKEN_ID)).not.toBe(base);
    expect(fingerprints([link({ source: { source: "audit", name: "broken-link", severity: "error" } })]).get(BROKEN_ID)).not.toBe(base);
    expect(fingerprints([link({ urgency: "high" })]).get(BROKEN_ID)).not.toBe(base);
  });
});

describe("dismissal and snooze: the decision's example table", () => {
  test("Odysseus dismisses it; an unrelated heading edit keeps the dismissal", async () => {
    const root = brain();
    const fp = finding(await run(root), BROKEN_ID).fingerprint;
    await run(root, at(1000), [{ kind: "dismissed", id: BROKEN_ID, expectFingerprint: fp, reason: "the hut is named in the next chapter" }]);
    expect(entry(root, BROKEN_ID)).toMatchObject({
      state: "dismissed",
      disposition: { kind: "dismissed", on: "2026-07-12T09:00:01Z", reason: "the hut is named in the next chapter", fingerprint: fp },
    });

    write(root, journey({ heading: "Homecoming" }));
    const after = await run(root, at(DAY));
    expect(stateOf(root, BROKEN_ID)).toBe("dismissed");
    expect(after).toMatchObject({ invalidated: 0, dismissed: 1 });
    expect(finding(after, BROKEN_ID).fingerprint).toBe(fp);
  });

  test("the target changes to another unresolved target: the disposition no longer suppresses it", async () => {
    const root = brain();
    const fp = finding(await run(root), BROKEN_ID).fingerprint;
    await run(root, NOW, [{ kind: "dismissed", id: BROKEN_ID, expectFingerprint: fp }]);

    write(root, journey({ target: "Eumaeus hut" }));
    const after = await run(root, at(DAY));
    expect(stateOf(root, CHANGED_ID)).toBe("open");
    expect(after.invalidations).toEqual([
      { id: CHANGED_ID, disposition: "dismissed", dispositionOn: "2026-07-12", changed: ["target", "tokens"], previousId: BROKEN_ID },
    ]);
    expect(entry(root, CHANGED_ID)?.invalidation).toEqual({
      on: "2026-07-13", disposition: "dismissed", dispositionOn: "2026-07-12", changed: ["target", "tokens"], previousId: BROKEN_ID,
    });
    expect(stateOf(root, BROKEN_ID)).toBe("resolved");
  });

  test("the link tokens change while the target stays: the same finding returns", async () => {
    const root = brain();
    const fp = finding(await run(root), BROKEN_ID).fingerprint;
    await run(root, NOW, [{ kind: "dismissed", id: BROKEN_ID, expectFingerprint: fp }]);
    write(root, journey({ label: "the swineherd's hut" }));
    const after = await run(root, at(DAY));
    expect(after.invalidations).toEqual([{ id: BROKEN_ID, disposition: "dismissed", dispositionOn: "2026-07-12", changed: ["tokens"], previousId: null }]);
    expect(stateOf(root, BROKEN_ID)).toBe("open");
  });

  for (const [what, extra, changed] of [
    ["source severity", { source: { source: "skill", name: "broken-link", severity: "error" } }, ["severity"]],
    ["explicitly known urgency", { source: { source: "skill", name: "broken-link", severity: "warning" }, urgency: "high" }, ["urgency"]],
  ] as const) {
    test(`its ${what} changes: the disposition is invalidated on the same path`, async () => {
      const root = brain();
      const fp = finding(await run(root), BROKEN_ID).fingerprint;
      await run(root, NOW, [{ kind: "dismissed", id: BROKEN_ID, expectFingerprint: fp }]);
      const joined: HygieneCandidate = { category: "broken-link", path: DOC, evidence: "Eumaios hut", message: "The hut link is broken", ...extra };
      const after = await run(root, at(DAY), [], [joined]);
      expect(finding(after, BROKEN_ID).fingerprint).not.toBe(fp);
      expect(after.invalidations).toEqual([{ id: BROKEN_ID, disposition: "dismissed", dispositionOn: "2026-07-12", changed: [...changed], previousId: null }]);
      expect(stateOf(root, BROKEN_ID)).toBe("open");
    });
  }

  test("Odysseus snoozes it; only its age increases before the due time: the snooze holds", async () => {
    const root = brain();
    const fp = finding(await run(root), BROKEN_ID).fingerprint;
    await run(root, NOW, [{ kind: "snoozed", id: BROKEN_ID, expectFingerprint: fp, until: "2026-07-20T08:00:00Z" }]);
    for (const days of [1, 5, 7]) {
      const after = await run(root, at(days * DAY));
      expect({ days, state: stateOf(root, BROKEN_ID), invalidated: after.invalidated }).toEqual({ days, state: "snoozed", invalidated: 0 });
    }
    expect(entry(root, BROKEN_ID)).toMatchObject({ until: "2026-07-20", dueAt: "2026-07-20T08:00:00Z", disposition: { kind: "snoozed", fingerprint: fp } });
  });

  test("its evidence stays unchanged and the snooze becomes due: eligible again on schedule", async () => {
    const root = brain();
    const fp = finding(await run(root), BROKEN_ID).fingerprint;
    await run(root, NOW, [{ kind: "snoozed", id: BROKEN_ID, expectFingerprint: fp, until: "2026-07-20T08:00:00Z" }]);
    await run(root, new Date("2026-07-20T07:59:59Z"));
    expect(stateOf(root, BROKEN_ID)).toBe("snoozed");
    const due = await run(root, new Date("2026-07-20T08:00:00Z"));
    expect(due).toMatchObject({ reopened: 1, invalidated: 0 });
    expect(entry(root, BROKEN_ID)).toMatchObject({ state: "open", disposition: null, invalidation: null });
  });

  test("its target changes before the snooze is due: the changed problem returns early", async () => {
    const root = brain();
    const fp = finding(await run(root), BROKEN_ID).fingerprint;
    await run(root, NOW, [{ kind: "snoozed", id: BROKEN_ID, expectFingerprint: fp, until: "2026-07-20T08:00:00Z" }]);
    write(root, journey({ target: "Eumaeus hut" }));
    const after = await run(root, at(DAY));
    expect(after.invalidations).toEqual([
      { id: CHANGED_ID, disposition: "snoozed", dispositionOn: "2026-07-12", changed: ["target", "tokens"], previousId: BROKEN_ID },
    ]);
    expect(stateOf(root, CHANGED_ID)).toBe("open");
  });

  test("the document also has a missing required field: that finding keeps its own disposition", async () => {
    const root = brain(journey({ title: false }));
    const first = await run(root);
    await run(root, NOW, [
      { kind: "dismissed", id: BROKEN_ID, expectFingerprint: finding(first, BROKEN_ID).fingerprint },
      { kind: "snoozed", id: TITLE_ID, expectFingerprint: finding(first, TITLE_ID).fingerprint, until: "2026-08-01" },
    ]);
    expect([stateOf(root, BROKEN_ID), stateOf(root, TITLE_ID)]).toEqual(["dismissed", "snoozed"]);

    // The link changes; the missing title does not, so only the link returns.
    write(root, journey({ title: false, target: "Eumaeus hut" }));
    const after = await run(root, at(DAY));
    expect(after.invalidations.map((i) => i.id)).toEqual([CHANGED_ID]);
    expect([stateOf(root, CHANGED_ID), stateOf(root, TITLE_ID)]).toEqual(["open", "snoozed"]);

    // A title written as an empty string is a different value of the same field: its snooze ends.
    write(root, journey({ title: false, target: "Eumaeus hut" }).replace("type: note", 'title: ""\ntype: note'));
    const changed = await run(root, at(2 * DAY));
    expect(changed.invalidations).toEqual([{ id: TITLE_ID, disposition: "snoozed", dispositionOn: "2026-07-12", changed: ["value"], previousId: null }]);
  });
});

describe("refusals", () => {
  test("a stale or unknown fingerprint is refused before anything is written", async () => {
    const root = brain();
    await run(root);
    const before = hygieneFiles(root);
    for (const [request, reason] of [
      [{ kind: "dismissed", id: BROKEN_ID, expectFingerprint: "000000000000" }, "stale-fingerprint"],
      [{ kind: "snoozed", id: CHANGED_ID, expectFingerprint: "000000000000", until: "2026-08-01" }, "not-detected"],
    ] as const) {
      let refusal: unknown;
      try {
        await run(root, at(DAY), [request]);
      } catch (e) {
        refusal = e;
      }
      expect(refusal).toBeInstanceOf(HygieneRefusal);
      expect((refusal as HygieneRefusal).reason).toBe(reason);
    }
    expect(hygieneFiles(root)).toEqual(before);
  });
});

describe("brain hygiene dismiss/snooze (fresh processes)", () => {
  const cli = async (root: string, ...args: string[]) => {
    const { stdout, stderr, code } = await runCli(root, [...args, "--json"]);
    let out: any = null;
    try {
      out = JSON.parse(stdout);
    } catch {
      // The assertion on `code` reports it, with stderr.
    }
    return { out, stderr, code };
  };
  const reconcileCli = async (root: string, ...flags: string[]) => {
    const result = await cli(root, "hygiene", "reconcile", ...flags);
    expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
    return result.out;
  };
  const listCli = async (root: string) => {
    const result = await cli(root, "hygiene", "list");
    expect(result.code).toBe(0);
    return result.out.entries as Array<Record<string, any>>;
  };

  test("one finding with two sources in reconcile and list; a dismissal survives an unrelated edit and returns on a target change", async () => {
    const root = brain();
    const first = await reconcileCli(root);
    const broken = first.detected.find((d: { id: string }) => d.id === BROKEN_ID);
    expect(broken.sources).toHaveLength(2);
    const listed = (await listCli(root)).find((e) => e.id === BROKEN_ID)!;
    expect(listed.sources).toHaveLength(2);
    expect(listed.fingerprint).toBe(broken.fingerprint);

    const dismissed = await cli(root, "hygiene", "dismiss", BROKEN_ID, "--expect-fingerprint", broken.fingerprint, "--reason", "named later");
    expect({ code: dismissed.code, stderr: dismissed.stderr }).toMatchObject({ code: 0 });
    expect(dismissed.out).toMatchObject({ status: "dismissed", id: BROKEN_ID, fingerprint: broken.fingerprint, reason: "named later" });
    expect(dismissed.out.changedFiles).toContain("context/hygiene/dismissed.md");

    write(root, journey({ heading: "Homecoming" }));
    expect(await reconcileCli(root)).toMatchObject({ invalidated: 0, dismissed: 1 });
    expect((await listCli(root)).find((e) => e.id === BROKEN_ID)).toMatchObject({ state: "dismissed" });

    write(root, journey({ target: "Eumaeus hut" }));
    const changed = await reconcileCli(root);
    expect(changed.invalidations).toEqual([
      expect.objectContaining({ id: CHANGED_ID, disposition: "dismissed", changed: ["target", "tokens"], previousId: BROKEN_ID }),
    ]);
    expect((await listCli(root)).find((e) => e.id === CHANGED_ID)).toMatchObject({
      state: "open", invalidation: expect.objectContaining({ disposition: "dismissed", changed: ["target", "tokens"] }),
    });
  });

  test("a snooze holds until its due time, then the unchanged finding returns", async () => {
    const root = brain();
    const fp = (await reconcileCli(root)).detected.find((d: { id: string }) => d.id === BROKEN_ID).fingerprint;
    const until = new Date(Date.now() + 2500).toISOString();
    const snoozed = await cli(root, "hygiene", "snooze", BROKEN_ID, "--until", until, "--expect-fingerprint", fp);
    expect({ code: snoozed.code, stderr: snoozed.stderr }).toMatchObject({ code: 0 });
    expect(snoozed.out).toMatchObject({ status: "snoozed", until });
    expect(await reconcileCli(root)).toMatchObject({ snoozed: 1, reopened: 0 });
    await Bun.sleep(Math.max(0, Date.parse(until) - Date.now()) + 100);
    expect(await reconcileCli(root)).toMatchObject({ snoozed: 0, reopened: 1, invalidated: 0 });
    expect((await listCli(root)).find((e) => e.id === BROKEN_ID)).toMatchObject({ state: "open", disposition: null });
  });

  test("a stale --expect-fingerprint exits non-zero with a structured refusal and writes nothing", async () => {
    const root = brain();
    const fp = (await reconcileCli(root)).detected.find((d: { id: string }) => d.id === BROKEN_ID).fingerprint;
    write(root, journey({ label: "the swineherd's hut" }));
    const before = hygieneFiles(root);
    for (const args of [
      ["dismiss", BROKEN_ID, "--expect-fingerprint", fp],
      ["snooze", BROKEN_ID, "--until", "2099-01-01", "--expect-fingerprint", fp],
    ]) {
      const refused = await cli(root, "hygiene", ...args);
      expect(refused.code).toBe(1);
      expect(refused.out).toEqual({
        status: "refused", reason: "stale-fingerprint", id: BROKEN_ID, expectedFingerprint: fp, currentFingerprint: expect.stringMatching(/^[0-9a-f]{12}$/),
      });
      expect(refused.out.currentFingerprint).not.toBe(fp);
    }
    expect(hygieneFiles(root)).toEqual(before);
  });

  test("brain validate still reports a dismissed error and exits 1", async () => {
    const root = brain(journey({ title: false }));
    const fp = (await reconcileCli(root)).detected.find((d: { id: string }) => d.id === TITLE_ID).fingerprint;
    const dismissed = await cli(root, "hygiene", "dismiss", TITLE_ID, "--expect-fingerprint", fp);
    expect(dismissed.code).toBe(0);
    expect((await listCli(root)).find((e) => e.id === TITLE_ID)).toMatchObject({ state: "dismissed" });
    const validated = await cli(root, "validate");
    expect(validated.code).toBe(1);
    expect(validated.out.issues).toContainEqual({ file: DOC, level: "error", message: "Missing required field: title" });
  });
});
