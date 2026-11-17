/**
 * Paged document discovery (#3643): the shared selection, cursor, prefix,
 * output bound and source warnings behind `brain list --overview`,
 * `brain_list`'s paged inputs and `pageIndexDocuments`. Runs against a copy
 * of the Odysseus corpus with a fleet of extra notes, more than the largest
 * list limit, and the neighbouring folders a prefix must not leak into.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
import { indexDbPath } from "@schlessera/brain-common/internal/index-location";

import { cleanup, makeTempBrain, runCli } from "./cli-harness";
import { openDatabase } from "../src/lib/db";
import {
  DOCUMENT_PAGE_MAX_BYTES,
  DocumentPageError,
  normalizePathPrefix,
  type DocumentPage,
  type DocumentPageInput,
  type PagedDocument,
} from "../src/lib/document-page";
import { listDocuments, pageDocuments } from "../src/lib/ops/read";
import { pageIndexDocuments } from "../src/queries/index";

let root: string;

/** More than MAX_LIST_LIMIT, so the largest page cannot hold the scope. */
const FLEET = 130;

function write(rel: string, text: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

function note(title: string, fields: Record<string, string>, body = "Notes from Ogygia."): string {
  const lines = Object.entries({ type: "note", title: JSON.stringify(title), created: "2026-07-01", status: "active", relevance: "secondary", ...fields })
    .map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n\n${body}\n`;
}

async function index(): Promise<void> {
  const run = await runCli(root, ["index", "--json"]);
  expect(run.code).toBe(0);
}

function withDb<T>(body: (db: Database) => T): T {
  const db = openDatabase(indexDbPath(root), { readonly: true });
  try {
    return body(db);
  } finally {
    db.close();
  }
}

const page = (input: Partial<DocumentPageInput> = {}, warnings: string[] = []): DocumentPage =>
  withDb((db) => pageDocuments({ db, root }, { limit: 20, ...input }, warnings));

/** Every page of one listing, following next_cursor to the end. */
function enumerate(input: Partial<DocumentPageInput>): { rows: PagedDocument[]; pages: DocumentPage[] } {
  const pages: DocumentPage[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 1000; i++) {
    const p = page({ ...input, cursor });
    pages.push(p);
    if (p.next_cursor === null) break;
    cursor = p.next_cursor;
  }
  return { rows: pages.flatMap((p) => p.documents), pages };
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

beforeAll(async () => {
  root = makeTempBrain();
  // The fleet shares five `updated` dates, so the path tie-break decides
  // most of the order.
  for (let i = 0; i < FLEET; i++) {
    const n = String(i).padStart(3, "0");
    write(`notes/fleet/ship-${n}.md`, note(`Ship ${n}`, { updated: `2026-07-0${(i % 5) + 1}`, summary: `"Hull ${n} of the Phaeacian fleet"` }));
  }
  // Neighbours of projects/active/raft that a segment-aware prefix excludes.
  write("projects/active/raft-old/notes.md", note("Old raft", { type: "project", updated: "2026-07-10" }));
  write("projects/active/raft.md", note("Raft (loose file)", { type: "project", updated: "2026-07-10" }));
  // LIKE wildcards in a folder name stay literal.
  write("notes/100%_done/a.md", note("Done list", { updated: "2026-07-11" }));
  write("notes/100xxdone/b.md", note("Not done list", { updated: "2026-07-11" }));
  // One summary far larger than a whole page.
  write("notes/loom/penelope.md", note("Penelope's loom", { updated: "2026-07-12", summary: JSON.stringify("Woven by day, unwoven by night. ".repeat(2000)) }));
  await index();
});

afterAll(() => cleanup(root));

describe("ordering and cursor", () => {
  test("a scope larger than the largest limit enumerates fully, without duplicates or omissions", () => {
    const expected = withDb((db) =>
      db
        .query<{ path: string }, []>(
          "SELECT path FROM documents WHERE path LIKE 'notes/fleet/%' ORDER BY updated DESC, path ASC"
        )
        .all()
        .map((r) => r.path)
    );
    expect(expected).toHaveLength(FLEET);
    for (const limit of [100, 7, 1]) {
      const { rows, pages } = enumerate({ pathPrefix: "notes/fleet", limit });
      expect(rows.map((r) => r.path)).toEqual(expected);
      expect(new Set(rows.map((r) => r.path)).size).toBe(FLEET);
      expect(pages.map((p) => p.total)).toEqual(pages.map(() => FLEET));
      expect(pages.length).toBe(Math.ceil(FLEET / limit));
      expect(pages.at(-1)!.next_cursor).toBeNull();
    }
  });

  test("a whole-brain enumeration matches the index row for row", () => {
    const expected = withDb((db) =>
      db
        .query<{ path: string }, []>("SELECT path FROM documents WHERE status != 'archived' ORDER BY updated DESC, path ASC")
        .all()
        .map((r) => r.path)
    );
    const { rows } = enumerate({ overview: true, limit: 100 });
    expect(rows.map((r) => r.path)).toEqual(expected);
  });

  test("a malformed cursor and a cursor from another listing are refused by name", () => {
    const first = page({ pathPrefix: "notes/fleet", limit: 5 });
    expect(first.next_cursor).toBeString();
    for (const bad of ["not a cursor!", "eyJ2IjoyfQ", Buffer.from("[]").toString("base64url")]) {
      expect(() => page({ pathPrefix: "notes/fleet", cursor: bad })).toThrow(DocumentPageError);
      expect(() => page({ pathPrefix: "notes/fleet", cursor: bad })).toThrow("cursor is not a cursor this listing issued");
    }
    expect(() => page({ pathPrefix: "notes", cursor: first.next_cursor! })).toThrow("cursor belongs to a listing with other filters or path_prefix");
    expect(() => page({ pathPrefix: "notes/fleet", type: "project", cursor: first.next_cursor! })).toThrow("cursor belongs to a listing");
    // The limit and the projection may change between pages.
    expect(page({ pathPrefix: "notes/fleet", limit: 9, overview: true, cursor: first.next_cursor! }).documents).toHaveLength(9);
  });
});

describe("path prefix", () => {
  const paths = (input: Partial<DocumentPageInput>) => enumerate({ ...input, limit: 100 }).rows.map((r) => r.path);

  test("matches whole segments: neighbouring folders and files do not leak in", () => {
    const raft = paths({ pathPrefix: "projects/active/raft" });
    expect(raft.length).toBeGreaterThan(0);
    expect(raft.filter((p) => !p.startsWith("projects/active/raft/"))).toEqual([]);
    expect(raft).not.toContain("projects/active/raft.md");
    expect(raft).not.toContain("projects/active/raft-old/notes.md");
    expect(paths({ pathPrefix: "projects/active/raft/" })).toEqual(raft);
    expect(paths({ pathPrefix: "projects/active/raf" })).toEqual([]);
  });

  test("a file key lists that file only", () => {
    expect(paths({ pathPrefix: "projects/active/raft.md" })).toEqual(["projects/active/raft.md"]);
  });

  test("LIKE wildcards in the prefix are literal", () => {
    expect(paths({ pathPrefix: "notes/100%_done" })).toEqual(["notes/100%_done/a.md"]);
  });

  test("the prefix narrows the listing filters, never widens them", () => {
    // Archived documents stay out unless the status asks for them.
    expect(paths({ pathPrefix: "projects/archive" })).toEqual([]);
    expect(paths({ pathPrefix: "projects/archive", status: "archived" })).toEqual(["projects/archive/one-old-build.md"]);
    expect(paths({ pathPrefix: "projects", type: "note" })).toEqual([]);
  });

  test("an escaping, absolute or malformed prefix is refused before any query", () => {
    for (const bad of ["../notes", "/etc", "C:/x", "notes\\fleet", "notes//fleet", "./notes", "notes/../me", "", " ", "notes\u0000"]) {
      expect(() => normalizePathPrefix(bad)).toThrow(DocumentPageError);
      expect(pageIndexDocuments({ brainPath: root, pathPrefix: bad })).toEqual({ ok: false, error: { code: "invalid_input", retryable: false } });
    }
  });
});

describe("output bound", () => {
  test("every page of every listing fits the bound as compact JSON", () => {
    for (const input of [{ overview: true, limit: 100 }, { limit: 100 }, { overview: true, pathPrefix: "notes", limit: 100 }]) {
      const { pages } = enumerate(input);
      for (const p of pages) {
        expect(bytes(p)).toBeLessThanOrEqual(DOCUMENT_PAGE_MAX_BYTES);
        expect(p.documents.length).toBeGreaterThan(0);
      }
    }
  });

  test("a page the bound ends early says so and continues exactly where it stopped", () => {
    const long = "A long account of the voyage past Scylla and Charybdis. ".repeat(40);
    // Warnings count against the bound; enough of them push rows to the next page.
    const warned = page({ pathPrefix: "notes/fleet", limit: 100, overview: true }, Array.from({ length: 3 }, () => long));
    expect(warned.truncated).toBe(true);
    expect(warned.documents.length).toBeLessThan(100);
    expect(bytes(warned)).toBeLessThanOrEqual(DOCUMENT_PAGE_MAX_BYTES);
    const next = page({ pathPrefix: "notes/fleet", limit: 100, overview: true, cursor: warned.next_cursor! });
    const all = enumerate({ pathPrefix: "notes/fleet", limit: 100, overview: true }).rows.map((r) => r.path);
    expect([...warned.documents, ...next.documents].map((r) => r.path)).toEqual(all.slice(0, warned.documents.length + next.documents.length));
  });

  test("warnings beyond their share are counted, not listed", () => {
    const many = Array.from({ length: 200 }, (_, i) => `warning ${i}: ${"the winds of Aeolus ".repeat(10)}`);
    const p = page({ pathPrefix: "notes/fleet", limit: 5 }, many);
    expect(p.warnings.length).toBeLessThan(many.length);
    expect(p.warnings.at(-1)).toMatch(/^\d+ more warning\(s\) omitted$/);
    expect(p.documents.length).toBeGreaterThan(0);
  });

  test("an oversized summary is clipped inside its row: valid JSON, a named clip and a page that advances", () => {
    const p = page({ pathPrefix: "notes/loom", overview: true });
    expect(bytes(p)).toBeLessThanOrEqual(DOCUMENT_PAGE_MAX_BYTES);
    expect(p.documents).toHaveLength(1);
    const [row] = p.documents;
    expect(row!.path).toBe("notes/loom/penelope.md");
    expect(row!.clipped).toEqual(["summary"]);
    expect(row!.summary!).toEndWith("…");
    expect(row!.summary!).toStartWith("Woven by day, unwoven by night.");
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
    // Among other rows, the oversized one leads its own page and the rest follow whole.
    const { rows, pages } = enumerate({ pathPrefix: "notes", overview: true, limit: 100 });
    expect(pages[0]!.documents[0]!.path).toBe("notes/loom/penelope.md");
    expect(rows.filter((r) => r.clipped)).toHaveLength(1);
  });
});

describe("overview projection", () => {
  test("the legacy listing keeps its six fields; the paged one adds overview fields only on request", () => {
    const legacy = withDb((db) => listDocuments(db, { limit: 5 })).documents;
    for (const r of legacy) expect(Object.keys(r)).toEqual(["path", "title", "type", "relevance", "status", "tags"]);
    const plain = page({ limit: 5 });
    expect(Object.keys(plain)).toEqual(["documents", "next_cursor", "total", "warnings"]);
    for (const r of plain.documents) expect(Object.keys(r)).toEqual(["path", "title", "type", "relevance", "status", "tags"]);
    for (const r of page({ pathPrefix: "projects/active", limit: 5, overview: true }).documents) {
      expect(Object.keys(r)).toEqual(["path", "title", "type", "relevance", "status", "tags", "summary", "updated", "deadline", "indexed_at", "indexed_body_bytes"]);
    }
  });

  test("a project overview answers status, dates and summaries without opening a file", () => {
    // What an agent would otherwise read file by file: every active project document.
    const p = page({ pathPrefix: "projects/active", overview: true, limit: 100 });
    const markdown = p.documents.filter((r) => r.path.endsWith(".md"));
    expect(markdown.length).toBeGreaterThanOrEqual(6);
    for (const row of markdown) {
      const raw = readFileSync(join(root, row.path), "utf8");
      const { data, content } = parseFrontmatter(raw);
      const iso = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v === undefined ? null : String(v));
      expect(row.summary).toBe((data.summary as string | undefined) ?? null);
      expect(row.status).toBe(String(data.status ?? "active"));
      expect(row.deadline).toBe(iso(data.deadline));
      if (data.updated !== undefined) expect(row.updated).toBe(iso(data.updated)!);
      // The indexed body, frontmatter excluded: never the whole file.
      expect(row.indexed_body_bytes).toBe(Buffer.byteLength(content, "utf8"));
      expect(row.indexed_body_bytes!).toBeLessThan(Buffer.byteLength(raw, "utf8"));
    }
    const status = markdown.find((r) => r.path === "projects/active/raft/status.md")!;
    expect(status).toMatchObject({ status: "active", updated: "2026-06-30", deadline: "2026-07-29", summary: "Latest planning check and next action for leaving Ogygia" });
    // One call replaces one brain_read per row, and returns fewer bytes than those reads would.
    const readBytes = markdown.reduce((n, r) => n + Buffer.byteLength(readFileSync(join(root, r.path), "utf8"), "utf8"), 0);
    expect(bytes(p)).toBeLessThan(readBytes);
  });

  test("a non-markdown asset has no body size", () => {
    // Keyless indexing describes no assets, so the row is written as a described image would be.
    const path = "projects/active/raft/photos/frame.png";
    const rw = openDatabase(indexDbPath(root));
    try {
      rw.run(
        `INSERT INTO documents (path, title, type, status, relevance, summary, created, updated, content, indexed_at, asset_type)
         VALUES (?, 'Raft frame', 'project', 'active', 'secondary', NULL, '2026-07-12', '2026-07-12', 'A pine frame lashed with rope.', ?, 'image')`,
        [path, new Date().toISOString()]
      );
      const asset = page({ pathPrefix: "projects/active/raft/photos", overview: true });
      expect(asset.documents.map((r) => r.path)).toEqual([path]);
      expect(asset.documents[0]!.indexed_body_bytes).toBeNull();
      // Assets are not stat-checked as markdown sources.
      expect(asset.warnings).toEqual([]);
    } finally {
      rw.run("DELETE FROM documents WHERE path = ?", [path]);
      rw.close();
    }
  });
});

describe("truthful warnings", () => {
  test("a source changed or removed after indexing is named on the page that lists it", () => {
    // Both on the first page: the newest `updated` (2026-07-05) comes first.
    const changed = "notes/fleet/ship-004.md";
    const removed = "notes/fleet/ship-009.md";
    const keep = readFileSync(join(root, removed), "utf8");
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(root, changed), future, future);
    rmSync(join(root, removed));
    try {
      const p = page({ pathPrefix: "notes/fleet", overview: true, limit: 100 });
      expect(p.warnings).toContainEqual(expect.stringMatching(/^source changed after indexing for 1 listed document\(s\) \(notes\/fleet\/ship-004\.md\)/));
      expect(p.warnings).toContainEqual(expect.stringMatching(/^source missing or unreadable for 1 listed document\(s\) \(notes\/fleet\/ship-009\.md\)/));
      // Only rows on the page are checked, and only for the overview.
      const other = page({ pathPrefix: "projects/active", overview: true, limit: 100 });
      expect(other.warnings).toEqual([]);
      expect(page({ pathPrefix: "notes/fleet", limit: 100 }).warnings).toEqual([]);
    } finally {
      writeFileSync(join(root, removed), keep);
      const now = new Date();
      utimesSync(join(root, changed), now, now);
    }
  });

  test("a cursor carried across an index change continues with a stale-cursor warning", async () => {
    const first = page({ pathPrefix: "notes/fleet", limit: 10 });
    expect(page({ pathPrefix: "notes/fleet", limit: 10, cursor: first.next_cursor! }).warnings).toEqual([]);
    write("notes/fleet/ship-new.md", note("Ship new", { updated: "2026-07-12" }));
    await index();
    try {
      const after = page({ pathPrefix: "notes/fleet", limit: 10, cursor: first.next_cursor! });
      expect(after.warnings).toEqual([
        "the index changed since this cursor was issued; documents changed in between may be skipped or repeated, so restart without cursor for a complete enumeration",
      ]);
      expect(after.documents).toHaveLength(10);
      expect(after.total).toBe(FLEET + 1);
      // The cursor it returns is current again.
      expect(page({ pathPrefix: "notes/fleet", limit: 10, cursor: after.next_cursor! }).warnings).toEqual([]);
    } finally {
      rmSync(join(root, "notes/fleet/ship-new.md"));
      await index();
    }
  });
});

describe("pageIndexDocuments", () => {
  test("returns the same page as the in-process operation", () => {
    for (const input of [{ pathPrefix: "projects/active", overview: true }, { limit: 3 }, { pathPrefix: "notes/fleet", limit: 100, overview: true }]) {
      const query = pageIndexDocuments({ brainPath: root, ...input });
      expect(query.ok).toBe(true);
      if (!query.ok) return;
      expect(query.value).toEqual(page({ limit: 20, ...input }));
    }
  });

  test("a bad cursor is invalid_input; a missing index is missing_index", () => {
    expect(pageIndexDocuments({ brainPath: root, cursor: "x" })).toEqual({ ok: false, error: { code: "invalid_input", retryable: false } });
    expect(pageIndexDocuments({ brainPath: root, overview: "yes" as never })).toEqual({ ok: false, error: { code: "invalid_input", retryable: false } });
    const empty = makeTempBrain({ empty: true });
    try {
      expect(pageIndexDocuments({ brainPath: empty })).toEqual({ ok: false, error: { code: "missing_index", retryable: false } });
    } finally {
      cleanup(empty);
    }
  });
});
