// The real `brain` CLI's agreement with a jobs-module fallback configuration
// on a disk-backed brain: module loading, `config check`, `config get`,
// `jobs pipeline`, `index --force` and `briefing`. The opportunity-lifecycle
// eval first exercised this (#1386 split it from the prototype tests); the
// fixture brain under tests/fixtures/opportunity-lifecycle/ holds an
// opportunity with an interview booked for 2026-07-20, which the shipped CLI
// then reads.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { brainConfigSchema } from "../packages/core/src/lib/config";
import { openDatabase } from "../packages/core/src/lib/db";
import { loadModules } from "../packages/core/src/lib/module-loader";
import { cli, createLab, doc, successful } from "./fixtures/opportunity-lifecycle/lab";

const configuration = JSON.stringify({ reranker: { enabled: false },
  modules: { "@schlessera/brain-module-jobs": { enabled: true, criteria: "work/leads/criteria.md", opportunitiesDir: "work/leads", boards: [], queries: [] } },
  taxonomy: { types: { opportunity: { dir: null } }, canonical: { currentFocus: "context/now.md" } },
}, null, 2) + "\n";
const call = "Screening with Mentor, 2026-07-20T09:00:00+02:00 (Europe/Berlin); Video, 30 minutes";
const files = { "brain.config.json": configuration,
  "work/leads/ithaca/status.md": doc("opportunity", "Tracked role", `stage: interviewing\nnext_step: ${call}\ndeadline: 2026-07-20\n`, "## Contacts\n\n| Name | Role | Relationship | Notes |\n|------|------|--------------|-------|\n\n## Notes\n\nOdysseus retains this research.\n"),
  "work/leads/ithaca/research.md": doc("opportunity", "Research", "", "Odysseus retains this research.\n"),
  "work/leads/ithaca/interview-prep.md": doc("opportunity", "Interview preparation", "deadline: 2026-07-20\n", `## Upcoming calls\n\n- [screen] ${call}\n\n## Related\n\n[[work/leads/ithaca/status]]\n[[work/leads/ithaca/research]]\n`),
  "work/leads/criteria.md": doc("note", "Criteria", "", "Keep the promised return to Ithaca.\n"),
  "context/now.md": doc("context", "Current focus", "", `- [[work/leads/ithaca/status]] — ${call}\n`),
};

test("fresh disk-backed module fallback agrees with actual config and pipeline CLI", async () => {
  const lab = createLab(files);
  try {
    const modules = await loadModules(brainConfigSchema.parse(JSON.parse(configuration)), lab.root);
    const jobs = modules.find(mod => mod.manifest.name === "jobs" && mod.state === "active");
    expect(jobs).toBeDefined();
    expect((jobs!.config as { opportunitiesDir?: unknown }).opportunitiesDir).toBe("work/leads");
    const config = successful(await cli(lab.root, ["config", "check", "--json"]));
    expect(JSON.parse(config.stdout).valid).toBe(true);
    expect(successful(await cli(lab.root, ["config", "get", "modules.@schlessera/brain-module-jobs"])).stdout).toContain("work/leads");
    const pipeline = successful(await cli(lab.root, ["jobs", "pipeline", "--json"]));
    expect(JSON.parse(pipeline.stdout).index).toBe("work/leads/_index.md");
    expect(existsSync(join(lab.root, "work/leads/_index.md"))).toBe(true);
    successful(await cli(lab.root, ["index", "--force"]));
    const db = openDatabase(join(lab.root, "brain.db"));
    try {
      expect(db.query("SELECT path, deadline FROM documents WHERE deadline IS NOT NULL ORDER BY path").all()).toEqual([
        { path: "work/leads/ithaca/interview-prep.md", deadline: "2026-07-20" },
        { path: "work/leads/ithaca/status.md", deadline: "2026-07-20" },
      ]);
    } finally { db.close(); }
    expect(successful(await cli(lab.root, ["briefing"])).stdout).toContain("2026-07-20 | work/leads/ithaca/interview-prep.md");
  } finally { lab.close(); }
}, 30000);
