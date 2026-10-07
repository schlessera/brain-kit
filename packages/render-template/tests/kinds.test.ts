import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";

import { buildHtmlDocument, isFullDocument } from "../src/template";
import { ACCENTS, DOCUMENT_BLOCKS, DOCUMENT_CLASSES, OPENER_CLASSES } from "../src/components";
import { DOCUMENT_KINDS, readSkeleton, resolveKind } from "../src/kinds";
import { lintDocument } from "../src/lint";

/** Warnings a skeleton is meant to raise: they mark what the author must fill in. */
const FILL_ME = new Set(["placeholder-image", "empty-link"]);

/** The first element inside <body>, with its class list. */
function firstBodyElement(html: string): { tag: string; classes: string[] } {
  const afterBody = html.slice(html.search(/<body\b[^>]*>/i)).replace(/^<body\b[^>]*>/i, "");
  const m = /^\s*<([a-z][a-z0-9-]*)\b([^>]*)>/i.exec(afterBody);
  if (!m) throw new Error("no element in <body>");
  const cls = /class="([^"]*)"/.exec(m[2])?.[1] ?? "";
  return { tag: m[1], classes: cls.split(/\s+/).filter(Boolean) };
}

describe("document kinds", () => {
  test("every skeleton file belongs to exactly one kind, and every kind has its file", () => {
    const files = readdirSync(new URL("../skeletons/", import.meta.url)).sort();
    expect(DOCUMENT_KINDS.map((k) => k.file).sort()).toEqual(files);
  });

  test("names and aliases are unique", () => {
    expect(DOCUMENT_KINDS.length, "the kind catalogue is populated").toBeGreaterThan(0);
    const words = DOCUMENT_KINDS.flatMap((k) => [k.name, ...k.aliases]);
    expect(new Set(words).size).toBe(words.length);
  });

  test("resolve by name or alias, case-insensitively", () => {
    expect(resolveKind("recipe")?.name).toBe("how-to");
    expect(resolveKind(" Day-Plan ")?.name).toBe("itinerary");
    expect(resolveKind("memo")?.name).toBe("brief");
    expect(resolveKind("poster")).toBeUndefined();
  });

  test("every block a kind names is in the catalogue", () => {
    expect(DOCUMENT_KINDS.length, "the kind catalogue is populated").toBeGreaterThan(0);
    const names = new Set(DOCUMENT_BLOCKS.map((b) => b.name));
    for (const kind of DOCUMENT_KINDS) {
      expect(kind.blocks.filter((b) => !names.has(b))).toEqual([]);
    }
  });

  for (const kind of DOCUMENT_KINDS.filter((k) => k.format === "html")) {
    describe(`${kind.name} skeleton`, () => {
      const source = readSkeleton(kind);
      const html = buildHtmlDocument({ content: source, contentType: "html" });

      test("is a complete document, built without nesting", () => {
        expect(isFullDocument(source)).toBe(true);
        expect(html.match(/<html\b/gi)).toHaveLength(1);
        expect(html.match(/<body\b/gi)).toHaveLength(1);
      });

      test("has exactly one opener, as the first element in <body>", () => {
        const openers = [...html.matchAll(/class="([^"]*)"/g)].filter((m) =>
          m[1].split(/\s+/).some((c) => (OPENER_CLASSES as readonly string[]).includes(c))
        );
        expect(openers).toHaveLength(1);
        const first = firstBodyElement(html);
        expect(first.classes.some((c) => (OPENER_CLASSES as readonly string[]).includes(c))).toBe(true);
      });

      test("sets the accent and switches its kind declares", () => {
        const body = /<body\b([^>]*)>/i.exec(source)?.[1] ?? "";
        const accent = /data-accent="([^"]*)"/.exec(body)?.[1] ?? "amber";
        expect(ACCENTS).toContain(accent as (typeof ACCENTS)[number]);
        expect(accent).toBe(kind.accent);
        const classes = /class="([^"]*)"/.exec(body)?.[1].split(/\s+/).filter(Boolean) ?? [];
        expect(classes.sort()).toEqual([...kind.switches].sort());
      });

      test("shows every block its kind names", () => {
        const used = new Set([...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)));
        const missing = kind.blocks.filter((name) => {
          const block = DOCUMENT_BLOCKS.find((b) => b.name === name)!;
          // "table" is the unclassed <table>; its one class is optional.
          return name === "table" ? !/<table>/.test(source) : !used.has(block.classes[0]);
        });
        expect(missing).toEqual([]);
      });

      test("uses only listed classes, and warns only about what is left to fill in", () => {
        const warnings = lintDocument(html);
        expect(warnings.filter((w) => !FILL_ME.has(w.code))).toEqual([]);
        const classes = [...source.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
        expect(classes.length).toBeGreaterThan(10);
        expect(classes.filter((c) => !DOCUMENT_CLASSES.includes(c))).toEqual([]);
      });
    });
  }

  test("the plain note is markdown with no component classes", () => {
    const note = DOCUMENT_KINDS.find((k) => k.name === "note")!;
    const html = buildHtmlDocument({ content: readSkeleton(note), contentType: "markdown" });
    expect(html).toContain("<table>");
    expect(html).toContain("<blockquote>");
    expect(html).not.toMatch(/class="doc-/);
    expect(lintDocument(html)).toEqual([]);
  });
});
