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

  test("a full note block keeps its quoted title, its tag list and the body after the fence", () => {
    const md = [
      "---",
      "type: note",
      'title: "Council at Pylos — Nestor on the Way Home"',
      "created: 2026-07-12",
      "tags: [pylos, nestor, voyage]",
      "status: active",
      "---",
      "",
      "## Context",
      "",
      "Body paragraph.",
    ].join("\n");
    const r = splitFrontmatter(md);
    expect(r.fields).toHaveLength(5);
    expect(r.fields[1].value).toBe("Council at Pylos — Nestor on the Way Home");
    expect(r.fields[3].list).toEqual(["pylos", "nestor", "voyage"]);
    expect(r.body.startsWith("\n## Context")).toBe(true);
  });

  test("preserves the body byte-exact (no trimming)", () => {
    const md = "---\nkey: v\n---\n\n\nbody line\n";
    const r = splitFrontmatter(md);
    expect(r.body).toBe("\n\nbody line\n");
  });

  // The fences are found by frontmatterBlock, the rule the indexer reads by (#2507).
  test("a closing fence at the end of the file closes the block", () => {
    const r = splitFrontmatter("---\ntitle: a\n---");
    expect(r.fields).toEqual([{ key: "title", value: "a" }]);
    expect(r.body).toBe("");
  });

  test("frontmatter after a byte order mark is read", () => {
    const r = splitFrontmatter("\uFEFF---\ntitle: a\n---\nbody\n");
    expect(r.fields).toEqual([{ key: "title", value: "a" }]);
    expect(r.body).toBe("body\n");
  });

  test("CRLF fences are read and the body keeps its line endings", () => {
    const r = splitFrontmatter("---\r\ntitle: a\r\n---\r\nbody\r\n");
    expect(r.fields).toEqual([{ key: "title", value: "a" }]);
    expect(r.body).toBe("body\r\n");
  });

  test("trailing whitespace after the opening fence still opens a block", () => {
    const r = splitFrontmatter("--- \ntitle: a\n---\nbody\n");
    expect(r.fields).toEqual([{ key: "title", value: "a" }]);
    expect(r.body).toBe("body\n");
  });

  test("a block that is never closed is shown as body, not hidden", () => {
    const md = "---\ntitle: a\nbody\n";
    expect(splitFrontmatter(md)).toEqual({ fields: [], body: md });
  });

  test("a leading blank line or a four-dash line is not frontmatter", () => {
    for (const md of ["\n---\ntitle: a\n---\nbody\n", "----\ntitle: a\n----\nbody\n"]) {
      expect(splitFrontmatter(md)).toEqual({ fields: [], body: md });
    }
  });
});
