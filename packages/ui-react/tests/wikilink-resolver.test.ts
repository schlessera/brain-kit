import { describe, test, expect } from "bun:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { WikiLink, renderBarePathsInText } from "../src/components/chat/brain-markdown-links.js";
import { BrainUiProvider } from "../src/root-context.js";
import { createBrainUiRoot } from "../src/root.js";

// Observe the production resolver through the component that consumes it.
// A copied resolver keeps passing when the app's resolver regresses.
function resolveWikilinkTarget(raw: string, slugMap: Record<string, string>): string | null {
  const root = createBrainUiRoot({ storage: null });
  try {
    root.stores.file.setState({ wikilinkMap: slugMap, wikilinkLoaded: true });
    // Zustand SSR reads the initial snapshot; make this seeded map its snapshot.
    root.stores.file.getInitialState = root.stores.file.getState;
    const markup = renderToStaticMarkup(React.createElement(BrainUiProvider, { root } as Parameters<typeof BrainUiProvider>[0],
      React.createElement(WikiLink, { target: raw })));
    const doc = new Window().document;
    doc.body.innerHTML = markup;
    return doc.querySelector("a")?.getAttribute("href")?.slice("#/files/".length) ?? null;
  } finally {
    root.dispose();
  }
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

// Observe the production scanner's WikiLink elements, before resolution.
function extractWikilinks(text: string): { target: string; label?: string }[] {
  return renderBarePathsInText(text).flatMap((node) =>
    React.isValidElement<{ target: string; label?: string }>(node) && node.type === WikiLink
      ? [{ target: node.props.target, label: node.props.label }]
      : []);
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
