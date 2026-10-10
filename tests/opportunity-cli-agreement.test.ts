// The real `brain` CLI's agreement with a jobs-module fallback configuration
// on a disk-backed brain: `config check`, `config get`, `jobs pipeline`,
// `index --force` and `briefing`. The opportunity-lifecycle eval first
// exercised this (#1386 split it from the prototype tests in
// experiments/opportunity-lifecycle-preparation.test.ts); its lab, prototype
// and observer only stage the brain the shipped CLI then reads.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { apply, createConfiguredLab, inspect } from "../scripts/evals/opportunity-lifecycle/prototype";
import { openDatabase } from "../packages/core/src/lib/db";
import { doc, schedule } from "../scripts/evals/opportunity-lifecycle/fixtures";
import { observe } from "../scripts/evals/opportunity-lifecycle/observation";
import { cli, successful } from "../scripts/evals/opportunity-lifecycle/cli";

const configuration = (enabled = true, fallback = true) => JSON.stringify({ reranker: { enabled: false },
  modules: { "@schlessera/brain-module-jobs": { enabled, criteria: "work/leads/criteria.md", opportunitiesDir: "work/leads", boards: [], queries: [] } },
  taxonomy: { types: { opportunity: { dir: fallback ? null : "work/leads" } }, canonical: { currentFocus: "context/now.md" } },
}, null, 2) + "\n";
function inputs(enabled = true) {
  const focus = "- [[work/leads/ithaca/status]] — Waiting to hear back.";
  return { focus, files: { "brain.config.json": configuration(enabled, enabled),
    "work/leads/ithaca/status.md": doc("opportunity", "Tracked role", "stage: applied\n", "## Contacts\n\n| Name | Role | Relationship | Notes |\n|------|------|--------------|-------|\n\n## Notes\n\nOdysseus retains this research.\n"),
    "work/leads/ithaca/research.md": doc("opportunity", "Research", "", "Odysseus retains this research.\n"),
    "work/leads/criteria.md": doc("note", "Criteria", "", "Keep the promised return to Ithaca.\n"),
    "context/now.md": doc("context", "Current focus", "", focus + "\n"),
  } };
}

test("fresh disk-backed module fallback agrees with actual config and pipeline CLI", async () => {
  const input = inputs(), lab = await createConfiguredLab(input.files);
  try {
    expect(lab.authority!.jobsEnabled).toBe(true);
    expect(lab.opportunitiesDir).toBe("work/leads");
    const config = successful(await cli(lab, ["config", "check", "--json"]));
    expect(JSON.parse(config.stdout).valid).toBe(true);
    expect(successful(await cli(lab, ["config", "get", "modules.@schlessera/brain-module-jobs"])).stdout).toContain("work/leads");
    const planned = inspect(lab, schedule(), input.focus);
    if (planned.outcome !== "planned") throw new Error(planned.reason);
    expect(apply(lab, planned.plan, true).outcome).toBe("applied");
    const pipeline = successful(await cli(lab, ["jobs", "pipeline", "--json"]));
    expect(JSON.parse(pipeline.stdout).index).toBe("work/leads/_index.md");
    expect(observe(lab.root)["work/leads/_index.md"]!.bytesBase64).toBeDefined();
    successful(await cli(lab, ["index", "--force"]));
    const db = openDatabase(join(lab.root, "brain.db"));
    try {
      expect(db.query("SELECT path, deadline FROM documents WHERE deadline IS NOT NULL ORDER BY path").all()).toEqual([
        { path: "work/leads/ithaca/interview-prep.md", deadline: "2026-07-20" },
        { path: "work/leads/ithaca/status.md", deadline: "2026-07-20" },
      ]);
    } finally { db.close(); }
    expect(successful(await cli(lab, ["briefing"])).stdout).toContain("2026-07-20 | work/leads/ithaca/interview-prep.md");
  } finally { lab.close(); }
}, 30000);
