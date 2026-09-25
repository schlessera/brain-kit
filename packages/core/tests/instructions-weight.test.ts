/**
 * lib/instructions-weight.ts: which `@` imports count, and how the
 * measurement treats symlinks, aliases, unreadable imports and skills that
 * could not be discovered. The CLI check over it is in
 * doctor-instructions-weight.test.ts.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { claudeImports, measureInstructions } from "../src/lib/instructions-weight";

const temps: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "brain-weight-"));
  temps.push(d);
  return d;
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

describe("claudeImports ignores @ inside code", () => {
  const cases: [string, string, string[]][] = [
    ["a plain import at a line start and after a space", "@a.md\nsee @b.md", ["a.md", "b.md"]],
    ["an email address", "mail me@example.org", []],
    ["home and absolute paths", "@~/x.md\n@/etc/x.md", []],
    ["a single-backtick span", "use `@a.md` then @b.md", ["b.md"]],
    ["a double-backtick span holding a backtick", "``@a.md ` still code`` @b.md", ["b.md"]],
    ["a double-backtick span not closed by a single backtick", "``code ` @a.md`` @b.md", ["b.md"]],
    ["an unmatched backtick, which is literal", "a ` then @b.md", ["b.md"]],
    ["a backtick fence", "```\n@a.md\n```\n@b.md", ["b.md"]],
    ["a tilde fence", "~~~md\n@a.md\n~~~\n@b.md", ["b.md"]],
    ["a fence closed only by a run at least as long", "````\n@a.md\n```\n@c.md\n````\n@b.md", ["b.md"]],
    ["a fence closed only by the same character", "~~~\n@a.md\n```\n@c.md\n~~~\n@b.md", ["b.md"]],
    ["an unclosed fence, which runs to the end", "@b.md\n```\n@a.md\n", ["b.md"]],
    ["a backtick run whose info string holds a backtick, which is not a fence", "```a`b\n@b.md", ["b.md"]],
    ["a fence indented four spaces, which is not a fence", "    ```\n@b.md", ["b.md"]],
    // #462: code is whatever the GFM parse says it is, containers included.
    ["a fence inside a blockquote", "> ~~~\n> @a.md\n> ~~~\n\n@b.md", ["b.md"]],
    ["a fence inside a list item, indented past three spaces", "- item\n\n    ~~~\n    @a.md\n    ~~~\n\n@b.md", ["b.md"]],
    ["an indented code block", "Prose.\n\n    @a.md\n\n@b.md", ["b.md"]],
    ["a one-line triple-backtick span, then an import", "```@a.md```\n\n@b.md", ["b.md"]],
  ];
  for (const [name, text, want] of cases) {
    test(name, () => {
      expect(claudeImports(text)).toEqual(want);
    });
  }
});

describe("measureInstructions", () => {
  const names = (root: string) => measureInstructions(root, []).contributors.map((c) => c.name);
  /** Contributors other than the core skills every brain discovers. */
  const files = (root: string) =>
    measureInstructions(root, []).contributors.filter((c) => !c.name.startsWith("skill "));

  test("a symlink out of the brain is not counted, and says so", () => {
    const root = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "rules.md"), "x".repeat(4000));
    symlinkSync(outside, join(root, "linked"));
    writeFileSync(join(root, "CLAUDE.md"), "@linked/rules.md\n");
    const m = measureInstructions(root, []);
    expect(files(root).map((c) => c.name)).toEqual(["CLAUDE.md"]);
    expect(m.notes).toEqual(["linked/rules.md resolves outside the brain and is not counted"]);
    expect(m.problems).toEqual([]);
  });

  test("an alias of a counted file counts once", () => {
    const root = tempDir();
    writeFileSync(join(root, "AGENTS.md"), "x".repeat(4000));
    symlinkSync(join(root, "AGENTS.md"), join(root, "alias.md"));
    writeFileSync(join(root, "CLAUDE.md"), "@alias.md\n@./AGENTS.md\n");
    expect(files(root)).toEqual([
      { name: "CLAUDE.md", tokens: 6 },
      { name: "alias.md", tokens: 1000 },
    ]);
  });

  test("a missing or unreadable import is a problem; a missing AGENTS.md is not", () => {
    const root = tempDir();
    writeFileSync(join(root, "locked.md"), "secret");
    writeFileSync(join(root, "CLAUDE.md"), "@missing.md\n@locked.md\n");
    chmodSync(join(root, "locked.md"), 0o000);
    try {
      const m = measureInstructions(root, []);
      expect(m.problems[0]).toBe("missing.md: not found");
      expect(m.problems[1]).toMatch(/^locked\.md: .*(EACCES|permission denied)/i);
      expect(m.problems).toHaveLength(2);
    } finally {
      chmodSync(join(root, "locked.md"), 0o644);
    }
  });

  test("a skill that could not be discovered is a problem", () => {
    const root = tempDir();
    const dir = join(root, ".agents", "skills", "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: broken\n---\n\nNo description.\n");
    const m = measureInstructions(root, []);
    expect(m.problems.some((p) => p.includes("broken") && p.includes("missing name or description"))).toBe(true);
    expect(names(root)).not.toContain("skill broken");
  });
});
