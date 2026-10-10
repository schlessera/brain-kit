// The shipped tag writer (`applyTagChanges`) behaviour that the tag-alias
// experiment first exercised (#1386 split it from the prototype's gate tests):
// existing alias chains and cycles, and a persisted alias in brain.config.json
// driving the writer without touching excluded paths. The fixture brain under
// tests/fixtures/tag-aliases/ only stages it.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepare, snapshot } from "./fixtures/tag-aliases/prepare";
import { initContext } from "../packages/core/src/lib/context";
import { applyTagChanges } from "../packages/core/src/lib/tags-apply";

test("existing chains resolve and cycles retain source bytes through the shipped writer", async () => {
  for (const cycle of [false, true]) {
    const env = prepare();
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
  const env = prepare();
  try {
    const { left: from, right: to } = env.fixture;
    const configPath = join(env.root, "brain.config.json");
    const config = { ...env.config, taxonomy: { ...env.config.taxonomy, tags: { ...env.config.taxonomy.tags,
      aliases: { ...env.config.taxonomy.tags.aliases, [from]: to } } } };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    const persisted = readFileSync(configPath, "utf8");
    const loaded = await initContext({ root: env.root }); // the persisted config, no in-memory override
    const before = snapshot(env.root);
    applyTagChanges(env.root, loaded.taxonomy, { only: from, dryRun: true });
    expect(snapshot(env.root)).toEqual(before);
    const result = applyTagChanges(env.root, loaded.taxonomy, { only: from });
    expect(result.report.files.length).toBeGreaterThan(0);
    expect(readFileSync(configPath, "utf8")).toBe(persisted);
    expect(readFileSync(join(env.root, "excluded/kept.md"), "utf8")).toBe(env.files["excluded/kept.md"]);
    expect(readFileSync(join(env.root, env.paths[0]), "utf8")).toBe(env.files[env.paths[0]]!.replace(`tags: [${from}]`, `tags: [${to}]`));
    const once = snapshot(env.root), reloaded = await initContext({ root: env.root });
    expect(applyTagChanges(env.root, reloaded.taxonomy, { only: from }).report.files).toEqual([]);
    expect(snapshot(env.root)).toEqual(once);
  } finally { env.close(); }
});
