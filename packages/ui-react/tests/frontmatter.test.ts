import { describe, test, expect } from "bun:test";
import { splitFrontmatter } from "../src/lib/frontmatter";

describe("splitFrontmatter", () => {
  test("returns the body unchanged when there is no frontmatter", () => {
    const md = "# Hello\n\nNo frontmatter here.";
    const r = splitFrontmatter(md);
    expect(r.fields).toEqual([]);
    expect(r.body).toBe(md);
  });

  test("parses a simple key:value block", () => {
    const md = `---\ntype: note\ntitle: Hello\n---\n# body`;
    const r = splitFrontmatter(md);
    expect(r.fields).toEqual([
      { key: "type", value: "note" },
      { key: "title", value: "Hello" },
    ]);
    expect(r.body).toBe("# body");
  });

  test("strips double quotes from values", () => {
    const md = `---\ntitle: "Hello, world"\n---\nbody`;
    const r = splitFrontmatter(md);
    expect(r.fields[0]).toEqual({ key: "title", value: "Hello, world" });
  });

  test("strips single quotes from values", () => {
    const md = `---\nslug: 'foo-bar'\n---\nbody`;
    const r = splitFrontmatter(md);
    expect(r.fields[0]).toEqual({ key: "slug", value: "foo-bar" });
  });

  test("parses inline array values into a list", () => {
    const md = `---\ntags: [a, b, c]\n---\nbody`;
    const r = splitFrontmatter(md);
    expect(r.fields[0].key).toBe("tags");
    expect(r.fields[0].list).toEqual(["a", "b", "c"]);
  });

  test("inline array respects quoted commas", () => {
    const md = `---\ntags: ["a, with comma", b]\n---\nbody`;
    const r = splitFrontmatter(md);
    expect(r.fields[0].list).toEqual(["a, with comma", "b"]);
  });

  test("skips comment-only and blank lines", () => {
    const md = `---\n# comment\n\nkey: value\n---\nbody`;
    const r = splitFrontmatter(md);
    expect(r.fields).toEqual([{ key: "key", value: "value" }]);
  });

  test("handles CRLF line endings", () => {
    const md = "---\r\ntype: note\r\n---\r\nbody";
    const r = splitFrontmatter(md);
    expect(r.fields).toEqual([{ key: "type", value: "note" }]);
    expect(r.body).toBe("body");
  });

  test("missing close fence falls back to no frontmatter", () => {
    const md = "---\ntype: note\nbody without close";
    const r = splitFrontmatter(md);
    expect(r.fields).toEqual([]);
    expect(r.body).toBe(md);
  });

  test("realistic brain repo frontmatter", () => {
    const md = [
      "---",
      "type: note",
      'title: "CloudFest 2026 — rtCamp Conversation"',
      "created: 2026-03-24",
      "tags: [cloudfest, rtcamp, agentic]",
      "status: active",
      "---",
      "",
      "## Context",
      "",
      "Body paragraph.",
    ].join("\n");
    const r = splitFrontmatter(md);
    expect(r.fields).toHaveLength(5);
    expect(r.fields[1].value).toBe("CloudFest 2026 — rtCamp Conversation");
    expect(r.fields[3].list).toEqual(["cloudfest", "rtcamp", "agentic"]);
    expect(r.body.startsWith("\n## Context")).toBe(true);
  });

  test("preserves the body byte-exact (no trimming)", () => {
    const md = "---\nkey: v\n---\n\n\nbody line\n";
    const r = splitFrontmatter(md);
    expect(r.body).toBe("\n\nbody line\n");
  });
});
