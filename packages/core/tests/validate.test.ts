import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { validate } from "../src/lib/validate";
import { buildTaxonomy } from "../src/lib/taxonomy";
import { brainConfigSchema } from "../src/lib/config";

const taxonomy = buildTaxonomy({
  user: brainConfigSchema.parse({
    taxonomy: { types: { study: { dir: "studies" } } },
  }),
});

const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

function makeCorpus(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "endoxa-validate-test-"));
  fixtures.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

function doc(fields: Record<string, string>, body = "body"): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fields)) lines.push(`${k}: ${v}`);
  lines.push("---", "", body, "");
  return lines.join("\n");
}

describe("validate", () => {
  test("a well-formed corpus produces no errors", () => {
    const root = makeCorpus({
      "me/identity.md": doc({
        type: "identity",
        title: "Identity",
        created: '"2026-01-01"',
        updated: '"2026-01-02"',
        tags: "[me]",
      }),
    });
    const issues = validate(root, taxonomy);
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
  });

  test("reports missing frontmatter as an error", () => {
    const root = makeCorpus({ "notes/raw.md": "no frontmatter here\n" });
    const issues = validate(root, taxonomy);
    expect(issues).toContainEqual({
      file: "notes/raw.md",
      level: "error",
      message: "Missing YAML frontmatter",
    });
  });

  test("reports an invalid type and lists the taxonomy's valid types", () => {
    const root = makeCorpus({
      "notes/x.md": doc({ type: "bogus", title: "X", tags: "[a]" }),
    });
    const errors = validate(root, taxonomy).filter((i) => i.level === "error");
    const typeError = errors.find((e) => e.message.startsWith("Invalid type"));
    expect(typeError).toBeDefined();
    expect(typeError!.message).toContain("study"); // a configured valid type
  });

  test("warns on unresolved and ambiguous wiki-links", () => {
    const root = makeCorpus({
      "studies/a/research.md": doc({ type: "study", title: "A Research", tags: "[a]" }),
      "studies/b/research.md": doc({ type: "study", title: "B Research", tags: "[b]" }),
      "me/identity.md": doc(
        { type: "identity", title: "Identity", tags: "[me]" },
        "See [[research]] and [[nonexistent]]."
      ),
    });
    const warnings = validate(root, taxonomy).filter((i) => i.level === "warning");
    expect(warnings.some((w) => w.message.includes("Ambiguous wiki-link: [[research]]"))).toBe(true);
    expect(warnings.some((w) => w.message.includes("Unresolved wiki-link: [[nonexistent]]"))).toBe(true);
  });
});
