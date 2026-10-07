/**
 * Every skill a package ships as manual-only for Claude Code
 * (`disable-model-invocation: true`) is manual-only for Codex too, which reads
 * the policy from `agents/openai.yaml` beside the SKILL.md. Codex discovers the
 * skill through the `.agents/skills/` symlink that `brain skills sync` makes,
 * so the yaml has to ship inside the package.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { parseFrontmatter } from "../packages/core/src/lib/frontmatter-parse";

const ROOT = resolve(import.meta.dir, "..");

const shipped = [...new Bun.Glob("packages/*/skills/*/SKILL.md").scanSync({ cwd: ROOT })]
  .sort()
  .map((rel) => join(ROOT, rel));

const manualOnly = shipped.filter(
  (file) => parseFrontmatter(readFileSync(file, "utf8")).data["disable-model-invocation"] === true
);

describe("shipped manual-only skills", () => {
  test("are found", () => {
    expect(manualOnly.map((f) => relative(ROOT, dirname(f)))).toEqual(
      expect.arrayContaining([
        "packages/core/skills/sync",
        "packages/module-speaking/skills/new-submission",
      ])
    );
  });

  test("each ships agents/openai.yaml with allow_implicit_invocation: false", () => {
    expect(manualOnly.length, "manual-only skills reach the policy assertions").toBeGreaterThan(0);
    const missing = manualOnly.filter((file) => {
      const yaml = join(dirname(file), "agents", "openai.yaml");
      if (!existsSync(yaml)) return true;
      const parsed = Bun.YAML.parse(readFileSync(yaml, "utf8")) as {
        policy?: { allow_implicit_invocation?: unknown };
      };
      return parsed?.policy?.allow_implicit_invocation !== false;
    });
    expect(missing.map((f) => relative(ROOT, dirname(f)))).toEqual([]);
  });
});
