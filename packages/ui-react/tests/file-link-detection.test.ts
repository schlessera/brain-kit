import { describe, test, expect } from "bun:test";

import React from "react";
import { classifyRepoPath, isInternalRepoDir, isInternalRepoPath } from "../src/stores/file-state.js";
import { DirLink, FileLink, renderBarePathsInText } from "../src/components/chat/brain-markdown-links.js";
import { processChildText, renderEntityTags } from "../src/components/chat/brain-markdown-entities.js";

// Observe the production scanner's elements, rather than a copied regex.
function extractBarePaths(text: string): string[] {
  return renderBarePathsInText(text).flatMap((node) =>
    React.isValidElement<{ path: string }>(node) && node.type === FileLink ? [node.props.path] : []);
}

describe("isInternalRepoPath", () => {
  test("accepts a markdown file path", () => {
    expect(isInternalRepoPath("notes/foo.md")).toBe(true);
  });
  test("accepts a nested path", () => {
    expect(isInternalRepoPath("notes/projects/2026/launch.md")).toBe(true);
  });
  test("accepts a top-level file with extension", () => {
    expect(isInternalRepoPath("README.md")).toBe(true);
  });
  test("rejects http URL", () => {
    expect(isInternalRepoPath("http://example.com/foo.md")).toBe(false);
  });
  test("rejects https URL", () => {
    expect(isInternalRepoPath("https://example.com")).toBe(false);
  });
  test("rejects mailto", () => {
    expect(isInternalRepoPath("mailto:a@b.com")).toBe(false);
  });
  test("rejects fragment", () => {
    expect(isInternalRepoPath("#section")).toBe(false);
  });
  test("rejects absolute path", () => {
    expect(isInternalRepoPath("/etc/passwd")).toBe(false);
  });
  test("rejects version string", () => {
    expect(isInternalRepoPath("1.2.3")).toBe(false);
    expect(isInternalRepoPath("18.0.0")).toBe(false);
  });
  test("rejects text with spaces", () => {
    expect(isInternalRepoPath("not a path")).toBe(false);
  });
  test("rejects undefined", () => {
    expect(isInternalRepoPath(undefined)).toBe(false);
  });
  test("rejects extension-less path", () => {
    expect(isInternalRepoPath("notes/foo")).toBe(false);
  });
});

describe("bare-path extraction", () => {
  test("finds a single path in prose", () => {
    expect(extractBarePaths("see notes/foo.md for details")).toEqual([
      "notes/foo.md",
    ]);
  });

  test("finds multiple paths", () => {
    const out = extractBarePaths(
      "Read notes/foo.md and projects/2026/launch.md to start."
    );
    expect(out).toEqual(["notes/foo.md", "projects/2026/launch.md"]);
  });

  test("does not match version numbers like 1.2.3", () => {
    expect(extractBarePaths("Version 1.2.3 was released")).toEqual([]);
  });

  test("does not match bare filenames without slash", () => {
    expect(extractBarePaths("see README.md please")).toEqual([]);
  });

  test("does not salvage a path-like tail from a raw URL", () => {
    expect(extractBarePaths("see https://example.com/path.md")).toEqual([]);
  });

  test("trailing punctuation is excluded by word boundary", () => {
    expect(extractBarePaths("see notes/foo.md, ok?")).toEqual(["notes/foo.md"]);
  });
});

function extractBareDirs(text: string): string[] {
  return renderBarePathsInText(text).flatMap((node) =>
    React.isValidElement<{ path: string }>(node) && node.type === DirLink ? [`${node.props.path}/`] : []);
}

describe("isInternalRepoDir", () => {
  test("accepts a nested dir with trailing slash", () => {
    expect(isInternalRepoDir("network/linkedin/post-templates/")).toBe(true);
  });
  test("rejects a dir without trailing slash", () => {
    expect(isInternalRepoDir("network/linkedin")).toBe(false);
  });
  test("rejects a single-segment trailing slash (ambiguous)", () => {
    expect(isInternalRepoDir("notes/")).toBe(false);
  });
  test("rejects URLs even with trailing slash", () => {
    expect(isInternalRepoDir("https://example.com/")).toBe(false);
  });
  test("rejects absolute path", () => {
    expect(isInternalRepoDir("/etc/foo/")).toBe(false);
  });
});

describe("classifyRepoPath", () => {
  test("file extension wins", () => {
    expect(classifyRepoPath("notes/foo.md")).toBe("file");
  });
  test("trailing slash → dir", () => {
    expect(classifyRepoPath("notes/projects/")).toBe("dir");
  });
  test("neither → null", () => {
    expect(classifyRepoPath("notes/projects")).toBeNull();
  });
  test("URL → null", () => {
    expect(classifyRepoPath("https://example.com/foo.md")).toBeNull();
  });
});

describe("bare-dir extraction", () => {
  test("finds a dir at end of sentence", () => {
    expect(extractBareDirs("see network/linkedin/post-templates/")).toEqual([
      "network/linkedin/post-templates/",
    ]);
  });

  test("finds a dir before whitespace", () => {
    expect(
      extractBareDirs("look in network/linkedin/post-templates/ for context")
    ).toEqual(["network/linkedin/post-templates/"]);
  });

  test("ignores a dir-like path without trailing slash", () => {
    expect(extractBareDirs("see network/linkedin/post-templates please")).toEqual([]);
  });

  test("ignores top-level trailing-slash tokens (need 2+ segments)", () => {
    expect(extractBareDirs("see notes/ folder")).toEqual([]);
  });
});

type Token =
  | { type: "text"; value: string }
  | { type: "path"; value: string }
  | { type: "entity"; tag: string; inner: Token[] };

// Translate real rendered nodes into assertions; no parsing/linkification
// logic is duplicated here. Fragments only collect their existing children.
function observedTokens(node: React.ReactNode): Token[] {
  if (typeof node === "string") return [{ type: "text", value: node }];
  if (Array.isArray(node)) return node.flatMap(observedTokens);
  if (!React.isValidElement<{ path?: string; className?: string; children?: React.ReactNode }>(node)) return [];
  if (node.type === FileLink) return [{ type: "path", value: node.props.path! }];
  if (node.type === "span" && node.props.className?.startsWith("entity-")) {
    return [{ type: "entity", tag: node.props.className.slice("entity-".length), inner: observedTokens(node.props.children) }];
  }
  return observedTokens(node.props.children);
}

function tokenize(text: string, fileLinks: boolean, entityTags: boolean): Token[] {
  return observedTokens(processChildText(text, { fileLinks, entityTags }));
}

describe("entity-tag + bare-path interaction", () => {
  test("file entity content is linkified", () => {
    const md = renderEntityTags("See <f>notes/foo.md</f> please.");
    const tokens = tokenize(md, true, true);
    const entity = tokens.find((t) => t.type === "entity");
    expect(entity).toBeDefined();
    if (entity?.type !== "entity") throw new Error("not entity");
    expect(entity.tag).toBe("f");
    expect(entity.inner).toEqual([{ type: "path", value: "notes/foo.md" }]);
  });

  test("entity content without a path stays as plain text", () => {
    const md = renderEntityTags("Met <co>Acme</co> today.");
    const tokens = tokenize(md, true, true);
    const entity = tokens.find((t) => t.type === "entity");
    if (entity?.type !== "entity") throw new Error("not entity");
    expect(entity.tag).toBe("co");
    expect(entity.inner).toEqual([{ type: "text", value: "Acme" }]);
  });

  test("entity content with mixed text and path", () => {
    const md = renderEntityTags("<p>see notes/foo.md for context</p>");
    const tokens = tokenize(md, true, true);
    const entity = tokens.find((t) => t.type === "entity");
    if (entity?.type !== "entity") throw new Error("not entity");
    expect(entity.tag).toBe("p");
    expect(entity.inner).toEqual([
      { type: "text", value: "see " },
      { type: "path", value: "notes/foo.md" },
      { type: "text", value: " for context" },
    ]);
  });

  test("top-level text outside entity tags is still linkified", () => {
    const md = renderEntityTags("From notes/a.md to <co>Acme</co>.");
    const tokens = tokenize(md, true, true);
    expect(tokens[0]).toEqual({ type: "text", value: "From " });
    expect(tokens[1]).toEqual({ type: "path", value: "notes/a.md" });
    expect(tokens[2]).toEqual({ type: "text", value: " to " });
    expect(tokens[3].type).toBe("entity");
    expect(tokens[4]).toEqual({ type: "text", value: "." });
  });

  test("fileLinks=false leaves entity content as plain text", () => {
    const md = renderEntityTags("<f>notes/foo.md</f>");
    const tokens = tokenize(md, false, true);
    const entity = tokens.find((t) => t.type === "entity");
    if (entity?.type !== "entity") throw new Error("not entity");
    expect(entity.inner).toEqual([{ type: "text", value: "notes/foo.md" }]);
  });
});
