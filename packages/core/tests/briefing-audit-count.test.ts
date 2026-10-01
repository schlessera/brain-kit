/** #785: the real briefing reports the audit's must-fix findings, not markers. */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { AuditIssue } from "../src/lib/types";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const roots: string[] = [];
afterAll(() => { for (const root of roots) cleanup(root); });

const today = new Date().toISOString().slice(0, 10);
const note = (body: string) => `---
type: note
title: Odysseus's mast notes
created: ${today}
updated: ${today}
tags: [ogygia]
status: active
relevance: secondary
---

${body}
`;

async function indexed(files: Record<string, string>, fromCorpus = false): Promise<string> {
  const root = makeTempBrain({ empty: !fromCorpus });
  roots.push(root);
  if (!fromCorpus) writeFileSync(join(root, "brain.config.ts"), "export default {};\n");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  expect((await runCli(root, ["index", "--json"])).code).toBe(0);
  return root;
}

async function auditOutput(root: string): Promise<{ issues: AuditIssue[]; errors: number; warnings: number; infos: number; mustFix: number }> {
  const result = await runCli(root, ["audit", "--json"]);
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout);
}

async function briefingOutput(root: string): Promise<string> {
  const result = await runCli(root, ["briefing"]);
  expect(result.code).toBe(0);
  return result.stdout;
}

function mustFixLine(count: number): string {
  return `- ${count} must-fix audit finding(s) (errors and warnings; brain audit)`;
}

describe("briefing audit count", () => {
  for (const withLogs of [false, true]) {
    test(`matches the non-empty audit must-fix set ${withLogs ? "with" : "without"} hygiene logs`, async () => {
      const files: Record<string, string> = {};
      if (withLogs) {
        files["context/hygiene/last-run.md"] = note(`## Last run: ${today}T09:30:00Z`);
        files["context/hygiene/open.md"] = note("### mast-lashing\nCheck the lashing.\n");
      }
      const root = await indexed(files, true);
      expect(existsSync(join(root, "context/hygiene/open.md"))).toBe(withLogs);
      const audited = await auditOutput(root);
      expect(audited.mustFix).toBeGreaterThan(0);
      expect(audited.infos).toBeGreaterThan(0);
      expect(audited.issues.some((issue) => issue.category === "todo")).toBe(true);
      expect(audited.issues.some((issue) => issue.category === "verify")).toBe(true);
      expect(audited.mustFix).toBe(audited.errors + audited.warnings);
      const briefing = await briefingOutput(root);
      expect(briefing).toContain(mustFixLine(audited.mustFix));
      expect(briefing.match(/must-fix audit finding\(s\)/g)).toHaveLength(1);
      expect(briefing).toContain("## Upkeep");
      expect(briefing).toContain("## Current Focus");
      expect(briefing).toContain("## Recently Active");
      if (withLogs) {
        expect(briefing).toContain(`- content-hygiene last ran ${today}, 0 day(s) ago`);
        expect(briefing).toContain("- 1 open (context/hygiene/open.md)");
      }
    });
  }

  test("non-empty TODO and VERIFY findings alone leave must-fix at zero", async () => {
    const root = await indexed({ "notes/mast.md": note("[TODO: splice the rope] [VERIFY: the timber is dry]") });
    const audited = await auditOutput(root);
    expect(audited.issues.filter((issue) => ["todo", "verify"].includes(issue.category))).toHaveLength(2);
    expect(audited.infos).toBeGreaterThanOrEqual(2);
    expect(audited.errors + audited.warnings).toBe(0);
    expect(audited.mustFix).toBe(0);
    expect(await briefingOutput(root)).toContain(mustFixLine(0));
  });

  test("includes async module errors and warnings while excluding module information", async () => {
    const root = await indexed({
      "notes/mast.md": note("[TODO: splice the rope]"),
      "brain.config.ts": 'export default { modules: { "./fixture-module": {} } };\n',
      "fixture-module/module.ts": `import { defineModule } from "@schlessera/brain";
import { z } from "zod";
export default defineModule({
  name: "fixture",
  configSchema: z.object({}),
  setup: () => ({ hygieneChecks: [async () => {
    await Promise.resolve();
    return ["error", "warning", "info"].map(severity => ({
      path: "notes/mast.md", severity, category: "fixture-module", message: "Mast fixture"
    }));
  }] })
});\n`,
    });
    const audited = await auditOutput(root);
    expect(audited.issues.filter((issue) => issue.category === "fixture-module").map((issue) => issue.severity)).toEqual(["error", "warning", "info"]);
    expect(audited.errors).toBe(1);
    expect(audited.warnings).toBe(1);
    expect(audited.infos).toBeGreaterThan(0);
    expect(audited.mustFix).toBe(2);
    expect(await briefingOutput(root)).toContain(mustFixLine(audited.mustFix));
  });
});
