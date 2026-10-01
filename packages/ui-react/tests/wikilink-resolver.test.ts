import { describe, test, expect } from "bun:test";

// Mirror of resolveWikilinkTarget in brain-markdown.tsx. Extracted here to
// avoid pulling in the React-heavy module under the bun test runtime.
function resolveWikilinkTarget(
  raw: string,
  slugMap: Record<string, string>
): string | null {
  const hashIdx = raw.indexOf("#");
  const noAnchor = hashIdx >= 0 ? raw.slice(0, hashIdx).trim() : raw.trim();
  if (!noAnchor) return null;
  if (noAnchor.includes("/")) {
    if (noAnchor.endsWith("/")) return null;
    return /\.[a-z0-9]{1,8}$/i.test(noAnchor) ? noAnchor : `${noAnchor}.md`;
  }
  return slugMap[noAnchor.toLowerCase()] ?? null;
}

const MAP: Record<string, string> = {
  "ai-development": "expertise/ai-development.md",
  "odysseus": "network/people/odysseus.md",
  readme: "README.md",
};

describe("resolveWikilinkTarget", () => {
  test("resolves a bare slug via the map", () => {
    expect(resolveWikilinkTarget("ai-development", MAP)).toBe(
      "expertise/ai-development.md"
    );
  });

  test("resolves case-insensitively", () => {
    expect(resolveWikilinkTarget("AI-Development", MAP)).toBe(
      "expertise/ai-development.md"
    );
  });

  test("returns null for unknown slugs", () => {
    expect(resolveWikilinkTarget("does-not-exist", MAP)).toBeNull();
  });

  test("treats slashed targets as paths and adds .md if missing", () => {
    expect(resolveWikilinkTarget("notes/foo", MAP)).toBe("notes/foo.md");
  });

  test("keeps explicit extension on slashed targets", () => {
    expect(resolveWikilinkTarget("notes/foo.markdown", MAP)).toBe(
      "notes/foo.markdown"
    );
  });

  test("strips anchor before lookup", () => {
    expect(resolveWikilinkTarget("ai-development#section-1", MAP)).toBe(
      "expertise/ai-development.md"
    );
  });

  test("strips anchor before path resolution", () => {
    expect(resolveWikilinkTarget("notes/foo#heading", MAP)).toBe(
      "notes/foo.md"
    );
  });

  test("rejects trailing-slash dir-shaped targets", () => {
    expect(resolveWikilinkTarget("notes/projects/", MAP)).toBeNull();
  });

  test("empty target returns null", () => {
    expect(resolveWikilinkTarget("", MAP)).toBeNull();
    expect(resolveWikilinkTarget("   ", MAP)).toBeNull();
    expect(resolveWikilinkTarget("#anchor-only", MAP)).toBeNull();
  });
});

// Mirror of WIKILINK_RE
const WIKILINK_RE = /\[\[([^\[\]\n|]+?)(?:\|([^\[\]\n]+?))?\]\]/g;

function extractWikilinks(text: string): { target: string; label?: string }[] {
  const out: { target: string; label?: string }[] = [];
  WIKILINK_RE.lastIndex = 0;
  let m;
  while ((m = WIKILINK_RE.exec(text)) !== null) {
    out.push({
      target: m[1].trim(),
      label: m[2]?.trim(),
    });
  }
  return out;
}

describe("WIKILINK_RE", () => {
  test("matches a bare slug", () => {
    expect(extractWikilinks("see [[ai-development]] for context")).toEqual([
      { target: "ai-development" },
    ]);
  });

  test("matches a piped wikilink", () => {
    expect(extractWikilinks("[[odysseus|Odysseus]]")).toEqual([
      { target: "odysseus", label: "Odysseus" },
    ]);
  });

  test("matches an anchored wikilink", () => {
    expect(
      extractWikilinks("[[network/collaborators#vercel--ai-sdk|collaborators.md]]")
    ).toEqual([
      {
        target: "network/collaborators#vercel--ai-sdk",
        label: "collaborators.md",
      },
    ]);
  });

  test("matches multiple per line", () => {
    expect(
      extractWikilinks("from [[a]] to [[b|Bee]] and [[c]]")
    ).toEqual([{ target: "a" }, { target: "b", label: "Bee" }, { target: "c" }]);
  });

  test("does not match unmatched brackets", () => {
    expect(extractWikilinks("[[ unclosed")).toEqual([]);
    expect(extractWikilinks("unopened ]]")).toEqual([]);
  });
});
