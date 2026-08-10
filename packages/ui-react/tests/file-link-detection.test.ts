import { describe, test, expect } from "bun:test";

// Mirror of isInternalRepoPath from client/src/stores/file-store.ts.
// Keep in sync — extracted here to avoid pulling in the full store (which
// references import.meta.env and would fail in the bun test runner).
const FILE_REF_RE = /^[a-z0-9_.-]+(\/[a-z0-9_.-]+)*\.[a-z0-9]{1,8}$/i;
const URL_LIKE_RE = /^(?:https?:|mailto:|tel:|#|\/)/i;
const VERSION_RE = /^\d+(\.\d+){1,3}$/;

function isInternalRepoPath(href: string | undefined): boolean {
  if (!href) return false;
  if (URL_LIKE_RE.test(href)) return false;
  if (VERSION_RE.test(href)) return false;
  if (href.includes(" ")) return false;
  return FILE_REF_RE.test(href);
}

// Mirror of BARE_PATH_RE from brain-markdown.tsx
const BARE_PATH_RE = /\b([a-z][a-z0-9_-]*(?:\/[a-z0-9._-]+)+\.[a-z0-9]{1,8})\b/gi;

function extractBarePaths(text: string): string[] {
  const out: string[] = [];
  BARE_PATH_RE.lastIndex = 0;
  let m;
  while ((m = BARE_PATH_RE.exec(text)) !== null) {
    if (isInternalRepoPath(m[1])) out.push(m[1]);
  }
  return out;
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

  test("matches the path-like tail of a raw URL when not autolinked", () => {
    // Realistic note: in the rendered tree, URLs are wrapped in <a> by
    // remarkGfm autolinker and we skip recursion into <a> — so this only
    // hits raw text outside any link, where treating the path as internal
    // is acceptable noise.
    expect(extractBarePaths("see https://example.com/path.md")).toEqual([
      "com/path.md",
    ]);
  });

  test("trailing punctuation is excluded by word boundary", () => {
    expect(extractBarePaths("see notes/foo.md, ok?")).toEqual(["notes/foo.md"]);
  });
});

// ----------------------------------------------------------------------------
// Directory references (trailing slash)
//
// Mirrors DIR_REF_RE / isInternalRepoDir in file-store.ts and BARE_DIR_RE in
// brain-markdown.tsx. Files and dirs use separate regexes; combined detection
// picks the earlier match when ranges overlap.
// ----------------------------------------------------------------------------

const DIR_REF_RE = /^[a-z0-9_.-]+(\/[a-z0-9_.-]+)+\/$/i;
const BARE_DIR_RE = /\b([a-z][a-z0-9_-]*(?:\/[a-z0-9._-]+)+\/)(?=$|[\s,;:!?)\]])/gi;

function isInternalRepoDir(href: string | undefined): boolean {
  if (!href) return false;
  if (URL_LIKE_RE.test(href)) return false;
  if (VERSION_RE.test(href)) return false;
  if (href.includes(" ")) return false;
  return DIR_REF_RE.test(href);
}

function classifyRepoPath(href: string | undefined): "file" | "dir" | null {
  if (isInternalRepoPath(href)) return "file";
  if (isInternalRepoDir(href)) return "dir";
  return null;
}

function extractBareDirs(text: string): string[] {
  const out: string[] = [];
  BARE_DIR_RE.lastIndex = 0;
  let m;
  while ((m = BARE_DIR_RE.exec(text)) !== null) {
    if (isInternalRepoDir(m[1])) out.push(m[1]);
  }
  return out;
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

// ----------------------------------------------------------------------------
// Entity-tag + bare-path interaction
//
// Mirrors brain-markdown.tsx's transformTextString — when entity markers wrap
// content, that content must still be scanned for bare paths so a tag like
// `<f>notes/foo.md</f>` produces both an entity span AND a file-link inside.
// ----------------------------------------------------------------------------

const ENTITY_START = "​​";
const ENTITY_SEP = "​";
const ENTITY_END = "​​​";

function renderEntityTags(md: string): string {
  return md.replace(
    /<(co|p|proj|ev|d|st|f)>([\s\S]*?)<\/\1>/g,
    (_m, tag, content) => `${ENTITY_START}${tag}${ENTITY_SEP}${content}${ENTITY_END}`
  );
}

type Token =
  | { type: "text"; value: string }
  | { type: "path"; value: string }
  | { type: "entity"; tag: string; inner: Token[] };

function tokenize(text: string, fileLinks: boolean, entityTags: boolean): Token[] {
  if (entityTags && text.includes(ENTITY_START)) {
    const pattern = new RegExp(
      `${ENTITY_START}(co|p|proj|ev|d|st|f)${ENTITY_SEP}(.*?)${ENTITY_END}`,
      "g"
    );
    const tokens: Token[] = [];
    let lastIndex = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      if (m.index > lastIndex) {
        tokens.push(...tokenize(text.slice(lastIndex, m.index), fileLinks, false));
      }
      tokens.push({
        type: "entity",
        tag: m[1],
        inner: tokenize(m[2], fileLinks, false),
      });
      lastIndex = pattern.lastIndex;
    }
    if (lastIndex < text.length) {
      tokens.push(...tokenize(text.slice(lastIndex), fileLinks, false));
    }
    return tokens;
  }

  if (!fileLinks) return [{ type: "text", value: text }];

  const tokens: Token[] = [];
  let lastIndex = 0;
  let m;
  BARE_PATH_RE.lastIndex = 0;
  while ((m = BARE_PATH_RE.exec(text)) !== null) {
    if (!isInternalRepoPath(m[1])) continue;
    if (m.index > lastIndex) tokens.push({ type: "text", value: text.slice(lastIndex, m.index) });
    tokens.push({ type: "path", value: m[1] });
    lastIndex = BARE_PATH_RE.lastIndex;
  }
  if (lastIndex < text.length) tokens.push({ type: "text", value: text.slice(lastIndex) });
  return tokens;
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
