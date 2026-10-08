import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, symlinkSync, unlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { fixtures, prepare } from "../scripts/evals/tag-aliases/fixtures";
import { candidates, proposal, question, applyReviewed, fullUsage, snapshot, type ExplicitReview } from "../scripts/evals/tag-aliases/prototype";
import { initContext } from "../packages/core/src/lib/context";
import { applyTagChanges } from "../packages/core/src/lib/tags-apply";
import type { JevChoiceAnswer } from "../packages/core/src/lib/jev";

const yes = (probability = .99, confidence = .99): JevChoiceAnswer => ({ type: "choice", choice: "same", probabilities: { same: probability, different: 1 - probability, uncertain: 0 }, confidence });
async function setup() {
  const env = prepare(fixtures.find(f => f.id === "pylos-synonym")!);
  const found = await candidates(env.root), pair = found.pairs[0];
  expect(pair, "contextual positive exercises a nonempty real candidate").toBeDefined();
  const proposed = proposal(pair, yes(), .9, found.brain.taxonomy.tags!.vocabulary!);
  expect(proposed).not.toBeNull();
  const value = proposed!;
  const review: ExplicitReview = { from: value.from, to: value.to, snapshotSha: pair.snapshotSha, configSha: pair.configSha,
    reviewedAllUsage: true, accepted: true, usage: await fullUsage(env.root, value.from, value.to) };
  return { ...env, found, value, review };
}

test("the fresh 21-case corpus has both splits, synonyms and conservative sparse unknowns", () => {
  expect(fixtures).toHaveLength(21);
  expect(fixtures.filter(f => f.split === "tuning")).toHaveLength(8);
  expect(fixtures.filter(f => f.split === "held-out")).toHaveLength(13);
  expect(fixtures.some(f => f.split === "held-out" && f.same === true)).toBe(true);
  expect(fixtures.some(f => f.same === null)).toBe(true);
});

test("actual candidates retain nonempty complete question context; missing calibration admits nothing", async () => {
  const env = await setup();
  try {
    const request = question(env.value.pair);
    expect(Object.keys(request.questions)).toEqual(["sameConcept"]);
    expect(env.value.pair.contexts[env.value.from][0].body.length).toBeGreaterThan(30);
    expect(proposal(env.value.pair, yes(), null, [env.value.to])).toBeNull();
    expect(proposal(env.value.pair, yes(.1, .99), .9, [env.value.to])).toBeNull();
    expect(proposal(env.value.pair, yes(.99, .1), .9, [env.value.to])).toBeNull();
  } finally { env.close(); }
});

test("probability does not permit a write without explicit full-usage review", async () => {
  const env = await setup();
  try {
    const before = snapshot(env.root);
    await expect(applyReviewed(env.root, env.value, null)).rejects.toThrow("Explicit complete-usage review");
    await expect(applyReviewed(env.root, env.value, { ...env.review, usage: {} })).rejects.toThrow("every current usage");
    expect(snapshot(env.root)).toEqual(before);
  } finally { env.close(); }
});

test("the complete-usage approval flag protects actual config and document writes", async () => {
  const env = await setup();
  try {
    const before = snapshot(env.root);
    let caught: unknown;
    try { await applyReviewed(env.root, env.value, { ...env.review, reviewedAllUsage: false } as unknown as ExplicitReview); }
    catch (error) { caught = error; }
    expect(snapshot(env.root), "unreviewed usage must preserve the complete original config and document bytes").toEqual(before);
    expect(caught).toBeInstanceOf(Error);
  } finally { env.close(); }
});

test("missing full usage bytes protect actual writes even when approval is present", async () => {
  const env = await setup();
  try {
    const before = snapshot(env.root);
    let caught: unknown;
    try { await applyReviewed(env.root, env.value, { ...env.review, usage: {} }); } catch (error) { caught = error; }
    expect(snapshot(env.root), "empty review bytes must preserve actual config and document bytes").toEqual(before);
    expect(String(caught)).toContain("every current usage");
  } finally { env.close(); }
});

test("representative samples never substitute for a review of all usage", async () => {
  const env = prepare(fixtures.find(f => f.id === "pylos-synonym")!);
  try {
    for (let i = 0; i < 4; i++) writeFileSync(join(env.root, `context/pylos/extra-${i}.md`), env.files[env.paths[0]]);
    const found = await candidates(env.root), pair = found.pairs[0];
    expect(pair.contexts[env.fixture.left]).toHaveLength(3);
    const usage = await fullUsage(env.root, pair.left, pair.right);
    expect(Object.keys(usage)).toHaveLength(6);
    const value = proposal(pair, yes(), .9, found.brain.taxonomy.tags!.vocabulary!)!;
    const review: ExplicitReview = { from: value.from, to: value.to, snapshotSha: pair.snapshotSha, configSha: pair.configSha,
      accepted: true, reviewedAllUsage: true, usage };
    const result = await applyReviewed(env.root, value, review);
    expect(result.report!.files).toHaveLength(5);
  } finally { env.close(); }
});

test("existing chains resolve and cycles retain source bytes through the shipped writer", async () => {
  for (const cycle of [false, true]) {
    const env = prepare(fixtures.find(f => f.id === "pylos-synonym")!);
    try {
      const data = { ...env.config, taxonomy: { ...env.config.taxonomy, tags: { ...env.config.taxonomy.tags,
        aliases: cycle ? { [env.fixture.left]: "council-log", "council-log": env.fixture.left } :
          { [env.fixture.left]: "council-log", "council-log": env.fixture.right } } } };
      writeFileSync(join(env.root, "brain.config.json"), JSON.stringify(data));
      const brain = await initContext({ root: env.root }), before = snapshot(env.root);
      const result = applyTagChanges(env.root, brain.taxonomy, { only: env.fixture.left });
      if (cycle) {
        expect(result.report.skipped.some(s => s.reason.includes("alias cycle"))).toBe(true);
        expect(snapshot(env.root)).toEqual(before);
      } else {
        expect(readFileSync(join(env.root, env.paths[0]), "utf8")).toContain(`tags: [${env.fixture.right}]`);
        const once = snapshot(env.root);
        expect(applyTagChanges(env.root, brain.taxonomy, { only: env.fixture.left }).report.files).toEqual([]);
        expect(snapshot(env.root)).toEqual(once);
      }
    } finally { env.close(); }
  }
});

test("a conflicting existing alias cannot be overwritten by the proposed pair", async () => {
  const env = prepare(fixtures.find(f => f.id === "pylos-synonym")!);
  try {
    const data = structuredClone(env.config);
    data.taxonomy.tags.aliases = { ...data.taxonomy.tags.aliases, [env.fixture.left]: "council-log" };
    writeFileSync(join(env.root, "brain.config.json"), JSON.stringify(data));
    const found = await candidates(env.root), pair = found.pairs[0], value = proposal(pair, yes(), .9, [env.fixture.right])!;
    const review: ExplicitReview = { from: value.from, to: value.to, snapshotSha: pair.snapshotSha, configSha: pair.configSha,
      accepted: true, reviewedAllUsage: true, usage: await fullUsage(env.root, value.from, value.to) };
    const before = snapshot(env.root);
    let caught: unknown;
    try { await applyReviewed(env.root, value, review); } catch (error) { caught = error; }
    expect(snapshot(env.root)).toEqual(before);
    expect(String(caught)).toContain("existing alias conflict");
  } finally { env.close(); }
});

test("actual persisted full config drives the existing writer, preserves exclusions and repeats without churn", async () => {
  const env = await setup();
  try {
    const before = snapshot(env.root);
    await applyReviewed(env.root, env.value, env.review, { dryRun: true });
    expect(snapshot(env.root)).toEqual(before);
    const result = await applyReviewed(env.root, env.value, env.review);
    expect(result.report!.files.length).toBeGreaterThan(0);
    const data = JSON.parse(readFileSync(join(env.root, "brain.config.json"), "utf8"));
    expect(data.taxonomy.tags.aliases).toEqual({ ...env.config.taxonomy.tags.aliases, [env.value.from]: env.value.to });
    expect(data.taxonomy.types).toEqual(env.config.taxonomy.types);
    expect(data.exclude).toEqual(env.config.exclude);
    expect(readFileSync(join(env.root, "excluded/kept.md"), "utf8")).toBe(env.files["excluded/kept.md"]);
    expect(readFileSync(join(env.root, env.paths[0]), "utf8")).toBe(env.files[env.paths[0]].replace(`tags: [${env.fixture.left}]`, `tags: [${env.fixture.right}]`));
    const once = snapshot(env.root), loaded = await initContext({ root: env.root });
    expect(applyTagChanges(env.root, loaded.taxonomy, { only: env.value.from }).report.files).toEqual([]);
    expect(snapshot(env.root)).toEqual(once);
  } finally { env.close(); }
});

test("changed source or binary membership invalidates the complete reviewed snapshot", async () => {
  const env = await setup();
  try {
    writeFileSync(join(env.root, "unexpected.bin"), new Uint8Array([0, 255]));
    const before = snapshot(env.root);
    let caught: unknown;
    try { await applyReviewed(env.root, env.value, env.review); } catch (error) { caught = error; }
    expect(readFileSync(join(env.root, env.paths[0]), "utf8"), "unexpected binary membership must veto the actual document write").toBe(env.files[env.paths[0]]);
    expect(snapshot(env.root)).toEqual(before);
    expect(String(caught)).toContain("Reviewed fixture or config changed");
  } finally { env.close(); }
});

test("the real writer retains concurrent editor bytes after approved config persistence", async () => {
  const env = await setup();
  try {
    const edited = env.files[env.paths[0]] + "\nNestor retains an independent council note.\n";
    const result = await applyReviewed(env.root, env.value, env.review, { beforeCommit(path) { if (path === env.paths[0]) writeFileSync(join(env.root, path), edited); } });
    expect(readFileSync(join(env.root, env.paths[0]), "utf8"), "the conditional writer must retain actual concurrent editor bytes").toBe(edited);
    expect(result.report!.skipped).toContainEqual({ path: env.paths[0], reason: "changed during apply" });
  } finally { env.close(); }
});

test("whole fixture observation includes symlink target and non-Markdown mtime", async () => {
  const env = prepare(fixtures[1]);
  try {
    symlinkSync("sentinel.bin", join(env.root, "inside-link"));
    const before = snapshot(env.root);
    utimesSync(join(env.root, "sentinel.bin"), new Date("2026-07-12"), new Date("2026-07-12"));
    expect(snapshot(env.root)["sentinel.bin"].mtime).not.toBe(before["sentinel.bin"].mtime);
    unlinkSync(join(env.root, "inside-link"));
    symlinkSync("brain.config.json", join(env.root, "inside-link"));
    expect(snapshot(env.root)["inside-link"].target).toBe("brain.config.json");
    unlinkSync(join(env.root, "inside-link"));
    symlinkSync("/etc/passwd", join(env.root, "outside-link"));
    expect(() => snapshot(env.root)).toThrow("External fixture symlink refused");
  } finally { env.close(); }
});

test("32, 128 and 256 actual tags enforce the output pair bound and disclose omissions", async () => {
  for (const size of [32, 128, 256]) {
    const env = prepare(fixtures[1]);
    try {
      const tags = Array.from({ length: size }, (_, i) => `tablet-${i.toString().padStart(3, "0")}`);
      const file = env.files[env.paths[0]].replace(`tags: [${env.fixture.left}]`, `tags: [${tags.join(", ")}]`);
      writeFileSync(join(env.root, env.paths[0]), file);
      const found = await candidates(env.root);
      expect(found.pairs).toHaveLength(128);
      expect(found.omitted).toBeGreaterThan(0);
      expect(found.pairs.every(p => Object.values(p.contexts).every(c => c.length > 0 && c.length <= 3))).toBe(true);
    } finally { env.close(); }
  }
});
