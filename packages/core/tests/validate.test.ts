import { afterAll, describe, expect, test } from "bun:test";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";
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
  const root = mkdtempSync(join(tmpdir(), "brain-kit-validate-test-"));
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

describe("an archived document that still claims primary relevance", () => {
  const brains: string[] = [];
  afterAll(() => { for (const dir of brains) cleanup(dir); });

  const ADDED = "projects/archive/pine-shelf.md";
  const MESSAGE = "status: archived contradicts relevance: primary; set relevance: historical";

  async function validateJson(addArchivedPrimary: boolean) {
    // A temp copy, so the pinned corpus counts in stats.test.ts stay put.
    const root = makeTempBrain();
    brains.push(root);
    if (addArchivedPrimary) {
      writeFileSync(join(root, ADDED), doc({
        type: "project",
        title: '"Pine Shelf (archived)"',
        created: "2025-01-10",
        updated: "2025-03-01",
        tags: "[project, woodworking]",
        status: "archived",
        relevance: "primary",
        summary: '"A finished pine shelf"',
      }));
    }
    const res = await runCli(root, ["validate", "--json"]);
    return JSON.parse(res.stdout) as { ok: boolean; issues: { file: string; level: string; message: string }[]; errors: number; warnings: number };
  }

  test("yields exactly one warning naming both fields and the fix", async () => {
    const report = await validateJson(true);
    const flagged = report.issues.filter((i) => i.message.includes("status: archived"));
    expect(flagged).toEqual([{ file: ADDED, level: "warning", message: MESSAGE }]);
    expect(MESSAGE).toContain("relevance: primary");
    expect(MESSAGE).toContain("relevance: historical");
  });

  test("the corpus's archived historical document yields none", async () => {
    const report = await validateJson(true);
    expect(report.issues.filter((i) => i.file === "projects/archive/one-old-build.md" && i.message === MESSAGE)).toEqual([]);
  });

  test("the --json report is unchanged apart from the new finding", async () => {
    const before = await validateJson(false);
    const after = await validateJson(true);
    expect(Object.keys(after).sort()).toEqual(["errors", "issues", "ok", "warnings"]);
    expect(after.issues.filter((i) => i.file !== ADDED)).toEqual(before.issues);
    expect(after.issues.filter((i) => i.file === ADDED)).toEqual([{ file: ADDED, level: "warning", message: MESSAGE }]);
    expect(after.warnings).toBe(before.warnings + 1);
    expect(after.errors).toBe(before.errors);
    expect(after.ok).toBe(before.ok);
  });
});

describe("validate against taxonomy.tags", () => {
  const withTags = (tags: object) =>
    buildTaxonomy({ user: brainConfigSchema.parse({ taxonomy: { tags } }) });
  const tagged = () =>
    makeCorpus({
      "notes/a.md": doc({ type: "note", title: "A", tags: "[talks, hiking]" }),
    });
  // Whole issues, severity included: a vocabulary finding is a warning, and
  // an error would fail `brain validate` on an otherwise valid brain.
  const tagWarnings = (issues: { message: string }[]) =>
    issues.filter((i) => i.message.includes("taxonomy.tags"));
  const warning = (message: string) => ({ file: "notes/a.md", level: "warning", message });

  test("warns on a tag that is an aliases key and names the canonical tag", () => {
    const issues = validate(tagged(), withTags({ aliases: { talks: "talk" } }));
    expect(tagWarnings(issues)).toEqual([warning('Tag "talks" is an alias in taxonomy.tags — use "talk"')]);
  });

  test("warns on a tag outside the vocabulary, once per tag, and not twice for an alias key", () => {
    const issues = validate(tagged(), withTags({ vocabulary: ["talk"], aliases: { talks: "talk" } }));
    expect(tagWarnings(issues)).toEqual([
      warning('Tag "talks" is an alias in taxonomy.tags — use "talk"'),
      warning('Tag "hiking" is not in taxonomy.tags.vocabulary'),
    ]);
  });

  test("stays silent about tags when taxonomy.tags is absent", () => {
    const issues = validate(tagged(), taxonomy);
    expect(tagWarnings(issues)).toEqual([]);
    expect(issues.filter((i) => i.message.includes('"talks"'))).toEqual([]);
  });
});
