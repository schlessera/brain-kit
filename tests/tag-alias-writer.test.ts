// The shipped tag writer (`applyTagChanges`) behaviour that the tag-alias
// experiment first exercised (#1386 split it from the prototype's gate tests
// in experiments/tag-alias-experiment.test.ts): existing alias chains and
// cycles, and a persisted config driving the writer without touching excluded
// paths. The experiment fixtures and reviewed-apply driver only stage the brain.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtures, prepare } from "../scripts/evals/tag-aliases/fixtures";
import { candidates, proposal, applyReviewed, fullUsage, snapshot, type ExplicitReview } from "../scripts/evals/tag-aliases/prototype";
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
