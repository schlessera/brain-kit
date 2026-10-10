import { expect, test } from "bun:test";
import { chmodSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { corpus, candidates, materializeCase, prepareCase, CORPUS_SHA } from "../scripts/evals/speaking-lifecycle/corpus";
import { capture, plan } from "../scripts/evals/speaking-lifecycle/prototype";
import { captureGuard, guardedApply, observe } from "../scripts/evals/speaking-lifecycle/full-observer";
import { calibrate, confirm, digest, proposal, request, sourcedFields } from "../scripts/evals/speaking-lifecycle/source-admission";
import type { JevChoiceAnswer } from "../packages/core/src/lib/jev";

test("fresh split uses distinct assembly/submission/talk identities and complete brains", () => {
  expect(corpus).toHaveLength(19);
  expect(corpus.filter(c => c.split === "tuning")).toHaveLength(3);
  for (const field of ["assembly", "submission", "otherSubmission", "talk", "source"] as const)
    expect(new Set(corpus.map(c => c[field])).size, field).toBe(corpus.length);
  expect(CORPUS_SHA).toHaveLength(64);
  // Held-out must contain every primary outcome the classifier can choose, not only acceptance.
  const held = corpus.filter(c => c.split === "held-out" && !c.action);
  for (const outcome of ["accepted", "rejected", "waitlisted", "backup", "unclear"] as const)
    expect(held.filter(c => c.expectedOutcome === outcome).length, outcome).toBeGreaterThan(0);
  for (const c of corpus) {
    const built = materializeCase(c);
    expect(Object.keys(built.initial)).toHaveLength(13);
    expect(Object.keys(built.expected).sort()).toEqual(Object.keys(built.initial).sort());
    expect(built.initial["notes/letter.md"]).toContain(c.source);
    expect(candidates(c)).toHaveLength(3);
    // Expected state never depends on which arm reads it: a supported decision always has a changed target.
    expect(built.refused, c.id).toBe(c.expectedOutcome === "unclear" && !c.action);
    expect(built.expected[built.first] !== built.initial[built.first], c.id).toBe(!built.refused);
  }
  const titled = corpus.find(c => c.title)!;
  const target = candidates(titled).find(v => v.submission === titled.submission)!;
  expect(target.title).toBe(titled.title!);
  expect(titled.source).toContain(titled.title!);
  expect(titled.source).not.toContain(titled.submission);
});

test.each(corpus)("$id: actual persisted module and complete source-authored final effects", async c => {
  const env = await prepareCase(c);
  try {
    expect(env.brain.modules.map(m => [m.manifest.name, m.state])).toEqual([["speaking", "active"]]);
    expect(env.brain.taxonomy.dirForType("tablet")).toBe("tablets");
    expect(env.brain.taxonomy.isExcludedPath("talks/alt-decks/keep.md")).toBe(true);
    const initial = observe(env.root);
    for (const step of env.steps) {
      const guard = captureGuard(env.root);
      const proposed = await plan(capture(env.root, env.brain.taxonomy), env.brain.taxonomy, step, env.paths, "2026-07-12");
      expect(proposed.refused, c.id).toEqual([]);
      expect(proposed.edits.length, c.id).toBeGreaterThan(0);
      const before = observe(env.root);
      guardedApply(env.root, proposed, guard, true);
      expect(observe(env.root)).toEqual(before);
      guardedApply(env.root, proposed, guard);
      const after = observe(env.root);
      const repeated = await plan(capture(env.root, env.brain.taxonomy), env.brain.taxonomy, step, env.paths, "2026-07-12");
      if (step.kind === "close") expect(repeated.refused).toEqual([{ path: "(brain)", reason: "Error: excluded or archived target" }]);
      else expect(repeated.refused).toEqual([]);
      expect(guardedApply(env.root, repeated, captureGuard(env.root)).written).toEqual([]);
      expect(observe(env.root)).toEqual(after);
    }
    for (const [path, expected] of Object.entries(env.expected))
      expect(readFileSync(join(env.root, path), "utf8"), `${c.id}/${path}`).toBe(expected);
    const final = observe(env.root);
    for (const path of ["brain.config.json", "assets/guard.bin", "modules/speaking/module.ts", "notes/letter.md", "travel/ogygia.md"])
      expect(final[path], path).toEqual(initial[path]);
    if (env.refused) expect(final).toEqual(initial);
  } finally { env.close(); }
});

const answer = (choice: string, probability = 1): JevChoiceAnswer => ({ type: "choice", choice, confidence: 1, probabilities: { [choice]: probability } });
test("selected probability and exact payload confirmation prevent actual target writes", async () => {
  const c = corpus[0], env = await prepareCase(c);
  try {
    const cs = candidates(c), answers = { conference: answer(c.assembly), submission: answer(c.submission), outcome: answer("accepted") };
    const candidate = proposal(c.source, cs, answers, 0.9)!;
    expect(candidate).not.toBeNull(); expect(candidate.confirmed).toBe(false);
    const initial = observe(env.root);
    const notConfirmed = await plan(capture(env.root, env.brain.taxonomy), env.brain.taxonomy, candidate, env.paths, "2026-07-12");
    guardedApply(env.root, notConfirmed, captureGuard(env.root)); expect(observe(env.root)).toEqual(initial);
    expect(proposal(c.source, cs, { ...answers, outcome: answer("accepted", 0.1) }, 0.9)).toBeNull();
    expect(proposal(c.source, cs, { ...answers, submission: answer("none") }, 0.9)).toBeNull();
    expect(proposal(c.source, cs, answers, null)).toBeNull();
    expect(confirm(candidate, { accepted: true, payloadSha: "wrong" })).toBeNull();
    const confirmed = confirm(candidate, { accepted: true, payloadSha: digest(JSON.stringify(candidate)) });
    expect(confirmed).not.toBeNull();
    const accepted = await plan(capture(env.root, env.brain.taxonomy), env.brain.taxonomy, confirmed, env.paths, "2026-07-12");
    expect(accepted.edits.length).toBeGreaterThan(2);
    guardedApply(env.root, accepted, captureGuard(env.root));
    expect(readFileSync(join(env.root, env.first), "utf8")).toBe(env.expected[env.first]);
  } finally { env.close(); }
});

test("condition/date authority is literal and mixed unsupported facts cause abstention", () => {
  const conditional = corpus.find(c => c.condition)!;
  expect(sourcedFields(conditional.source)).toEqual({ date: "2026-07-11", conditions: conditional.condition, confirmation: "2026-07-13", slides: "2026-07-14" });
  expect(sourcedFields(corpus.find(c => c.id === "held-mixed-date")!.source)).toBeNull();
  for (const id of ["held-title-reject", "held-negation-accept", "held-plain-reject"])
    expect(sourcedFields(corpus.find(c => c.id === id)!.source), id).toEqual({ date: "2026-07-11" });
  for (const suffix of ["Return on 2026-07-13", "Return on 13 Jul", "Return on 13 July", "An extra deadline is soon", "Shorten it again", "Decision date: 2026-07-11"])
    expect(sourcedFields(`${corpus[0].source}\n${suffix}`), suffix).toBeNull();
  expect(sourcedFields("Selection recorded\nDecision date: 2026-02-30")).toBeNull();
  const req = request(conditional.source, candidates(conditional));
  expect(req.state).toHaveProperty("untrustedSource", conditional.source);
  expect(JSON.stringify(req)).not.toContain("expectedOutcome");
  expect(JSON.stringify(req)).not.toContain('"split"');
  expect(Object.keys(req.questions)).toEqual(["conference", "submission", "outcome"]);
});

test.each(["selected probability", "unsupported source date", "unbound confirmation"])("%s cannot produce an actual source/target write", async mode => {
  const c = corpus[0], env = await prepareCase(c);
  try {
    const before = observe(env.root);
    const source = c.source + (mode === "unsupported source date" ? "\nReturn on 14 July" : "");
    const answers = { conference: answer(c.assembly), submission: answer(c.submission), outcome: answer("accepted", mode === "selected probability" ? 0.1 : 1) };
    const value = proposal(source, candidates(c), answers, 0.9);
    const confirmed = value ? confirm(value, { accepted: true, payloadSha: mode === "unbound confirmation" ? "different-payload" : digest(JSON.stringify(value)) }) : null;
    const proposed = await plan(capture(env.root, env.brain.taxonomy), env.brain.taxonomy, confirmed, env.paths, "2026-07-12");
    guardedApply(env.root, proposed, captureGuard(env.root));
    expect(readFileSync(join(env.root, env.first), "utf8")).toBe(env.initial[env.first]);
    expect(observe(env.root)).toEqual(before);
    expect(proposed.edits).toEqual([]);
  } finally { env.close(); }
});

test("same-byte one-nanosecond evidence touch vetoes an actual write plan", async () => {
  const env = await prepareCase(corpus[0]);
  try {
    const path = join(env.root, "notes/letter.md"), beforeStat = statSync(path, { bigint: true });
    const guard = captureGuard(env.root), target = readFileSync(join(env.root, env.first));
    const proposed = await plan(capture(env.root, env.brain.taxonomy), env.brain.taxonomy, env.steps[0], env.paths, "2026-07-12");
    expect(proposed.edits.length).toBeGreaterThan(2);
    const python = Bun.spawnSync(["python3", "-B", "-c", "import os,sys; p=sys.argv[1]; s=os.stat(p); os.utime(p, ns=(s.st_atime_ns,s.st_mtime_ns+1))", path]);
    expect(python.exitCode).toBe(0);
    expect(statSync(path, { bigint: true }).mtimeNs).toBe(beforeStat.mtimeNs + 1n);
    let error: unknown; try { guardedApply(env.root, proposed, guard); } catch (e) { error = e; }
    expect(readFileSync(join(env.root, env.first))).toEqual(target);
    expect(String(error)).toContain("Complete fixture changed");
  } finally { env.close(); }
});

test.each(["binary", "new file", "mode", "symlink"])("%s metadata/evidence change vetoes a nonempty actual write plan", async mode => {
  const env = await prepareCase(corpus[0]);
  try {
    symlinkSync("notes/letter.md", join(env.root, "source-link"));
    const guard = captureGuard(env.root), beforeTarget = readFileSync(join(env.root, env.first));
    const proposed = await plan(capture(env.root, env.brain.taxonomy), env.brain.taxonomy, env.steps[0], env.paths, "2026-07-12");
    expect(proposed.edits.length).toBeGreaterThan(2);
    if (mode === "binary") writeFileSync(join(env.root, "assets/guard.bin"), Buffer.from([0, 255, 129, 13, 10]));
    if (mode === "new file") writeFileSync(join(env.root, "owner-new.bin"), Buffer.from([255, 0]));
    if (mode === "mode") chmodSync(join(env.root, "notes/letter.md"), 0o600);
    if (mode === "symlink") { unlinkSync(join(env.root, "source-link")); symlinkSync("travel/ogygia.md", join(env.root, "source-link")); }
    const changed = observe(env.root);
    let error: unknown; try { guardedApply(env.root, proposed, guard); } catch (e) { error = e; }
    expect(readFileSync(join(env.root, env.first))).toEqual(beforeTarget);
    expect(observe(env.root)).toEqual(changed);
    expect(String(error)).toContain("Complete fixture changed");
  } finally { env.close(); }
});

test("calibration requires complete tuning-only rows and excludes held-out decisions", () => {
  const rows = corpus.filter(c => c.split === "tuning").map(c => ({ id: c.id, split: c.split, accepted: c.expectedOutcome !== "unclear", correct: true, confidence: 0.9, probability: 0.9 }));
  const ids = rows.map(r => r.id);
  expect(calibrate(rows, ids)).toBe(0.7);
  expect(() => calibrate(rows.slice(1), ids)).toThrow("Complete tuning-only");
  expect(() => calibrate([{ ...rows[0], split: "held-out" }, ...rows.slice(1)], ids)).toThrow("Complete tuning-only");
  expect(calibrate(rows.map(r => ({ ...r, accepted: false })), ids)).toBeNull();
});
