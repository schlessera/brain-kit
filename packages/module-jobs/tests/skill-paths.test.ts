/**
 * The jobs skills write wherever `opportunitiesDir` points, not to the
 * default: every path goes through a placeholder resolved from
 * `brain config check --json` before the first write.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const SKILLS = ["research-opportunity", "interview-scheduled"];
const read = (skill: string) => readFileSync(join(import.meta.dir, "../skills", skill, "SKILL.md"), "utf-8");

describe.each(SKILLS)("%s", (skill) => {
  test("names career/opportunities only in the sentence about the default", () => {
    const sentences = read(skill)
      .split(/(?<=[.!?])\s+/)
      .filter((sentence) => sentence.includes("career/opportunities"));
    expect(sentences).toHaveLength(1);
    expect(sentences[0]).toMatch(/default/);
  });

  test("resolves the directory, and its fallback, before any path uses it", () => {
    const text = read(skill);
    const firstPath = text.indexOf("{opportunities}/");
    expect(firstPath).toBeGreaterThan(-1);
    for (const step of [
      "brain config check --json",
      "taxonomy.types.opportunity.dir",
      "brain config get modules.@schlessera/brain-module-jobs",
      "opportunitiesDir",
    ]) {
      const at = text.indexOf(step);
      expect({ step, before: at > -1 && at < firstPath }).toEqual({ step, before: true });
    }
  });

  test("stops when the config is invalid or the module is not enabled", () => {
    const text = read(skill);
    expect(text).toMatch(/"valid": false`, stop/);
    expect(text).toMatch(/prints\s+`null`, the jobs module is not enabled: stop/);
  });
});

// The lookups the skills name, run against a brain whose taxonomy leaves the
// opportunity directory to the module (dir: null), as `jobs scaffold` reads it.
describe("the documented lookup", () => {
  const BRAIN_BIN = resolve(import.meta.dir, "../../core/src/cli/brain.ts");
  const roots: string[] = [];
  afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

  async function brain(root: string, ...args: string[]): Promise<unknown> {
    const proc = Bun.spawn(["bun", BRAIN_BIN, ...args], {
      env: { ...process.env, BRAIN_ROOT: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    return JSON.parse(out);
  }

  function makeBrain(config: object): string {
    const root = mkdtempSync(join(tmpdir(), "jobs-skill-paths-"));
    roots.push(root);
    symlinkSync(resolve(import.meta.dir, "../../../node_modules"), join(root, "node_modules"));
    writeFileSync(join(root, "brain.config.json"), JSON.stringify(config));
    return root;
  }

  test("a null taxonomy directory falls back to the module's opportunitiesDir", async () => {
    const root = makeBrain({
      modules: { "@schlessera/brain-module-jobs": { criteria: "criteria.md", opportunitiesDir: "work/pipeline" } },
      taxonomy: { types: { opportunity: { dir: null } } },
    });
    const check = (await brain(root, "config", "check", "--json")) as {
      valid: boolean;
      taxonomy: { types: { opportunity: { dir: string | null } } };
    };
    expect(check.valid).toBe(true);
    expect(check.taxonomy.types.opportunity.dir).toBeNull();
    const block = (await brain(root, "config", "get", "modules.@schlessera/brain-module-jobs")) as { opportunitiesDir?: string };
    expect(block.opportunitiesDir).toBe("work/pipeline");
  });

  test("a brain without the jobs module prints null for its block", async () => {
    const root = makeBrain({});
    expect(await brain(root, "config", "get", "modules.@schlessera/brain-module-jobs")).toBeNull();
  });
});
