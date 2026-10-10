// The library's invariants, asserted.
//
// The library is the Odysseus world at full size, so it decays the way a big
// brain does: a renamed record strands every link to it, a journal entry
// drifts off its day, and a crew roster stops summing to the ledger it sits
// beside. Each test below names one of those failures.
//
// Some of that decay is wanted. The inbox, the archive and the loose notes
// carry the mess a real brain has: links to notes never written, captures
// nobody linked, records that link nowhere, links written by file name. That
// mess is declared in `knownIssues`, and the test holds it to exactly what is
// declared, so it can neither spread into the curated domains nor quietly
// disappear.

import { describe, expect, test } from "bun:test";
import { join, resolve } from "path";

import { knownIssues, library, libraryDomains, messDomains, shipRecords } from "../fixtures/library/index.js";
import { crewEmbarked, crewLosses, shipsEmbarked } from "../fixtures/money.js";
import { notes } from "../fixtures/notes.js";
import { people } from "../fixtures/people.js";
import { places } from "../fixtures/places.js";
import { goal, projects } from "../fixtures/projects.js";
import { DAYS_SINCE_TROY, REFERENCE_DATE, TROY_FELL, daysSince } from "../fixtures/time.js";
import type { LibraryDocument } from "../fixtures/library/index.js";

const LIBRARY_DIR = resolve(import.meta.dir, "..", "fixtures", "library");
const fixtureTitles = new Map<string, string>([
  ...notes.map((n) => [n.path, n.title] as [string, string]),
  ...people.map((p) => [p.path, p.name] as [string, string]),
  ...projects.map((p) => [p.path, p.title] as [string, string]),
  [goal.path, goal.title],
]);
const fixturePaths = new Set(fixtureTitles.keys());
const libraryPaths = new Set(library.map((d) => d.path));
const allPaths = new Set([...fixturePaths, ...libraryPaths]);
const personIds = new Set(people.map((p) => p.id));
const placeIds = new Set(places.map((p) => p.id));
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const WIKILINK = /\[\[([^[\]\n]+?)\]\]/g;

// Bare names resolve as the product's slug map does: title slug, then file
// name, then full path, later passes winning (website/src/demo/corpus.ts).
const titled = [...[...fixtureTitles].map(([path, title]) => ({ path, title })), ...library.map((d) => ({ path: d.path, title: d.title }))];
const slugs = new Map<string, string>();
const ambiguous = new Set<string>();
for (const slugOf of [(r: { title: string }) => r.title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), (r: { path: string }) => r.path.split("/").at(-1)!.replace(/\.md$/, "")]) {
  const seen = new Map<string, string>();
  for (const r of titled) {
    const slug = slugOf(r as never).toLowerCase();
    if (seen.has(slug) && seen.get(slug) !== r.path) ambiguous.add(slug);
    seen.set(slug, r.path);
    slugs.set(slug, r.path);
  }
}
for (const r of titled) slugs.set(r.path.replace(/\.md$/, "").toLowerCase(), r.path);

/** What a wiki-link points at, as the product resolves it: a path as written, or a bare name by slug. */
function target(raw: string): string {
  const text = raw.split("|")[0].split("#")[0].trim();
  if (text.includes("/")) return /\.[a-z0-9]{1,8}$/i.test(text) ? text : `${text}.md`;
  return slugs.get(text.toLowerCase()) ?? text;
}
const wikilinks = (body: string) => [...body.matchAll(WIKILINK)].map((m) => m[1]);

/** Day N is TROY_FELL plus N days; returns null for paths with no day. */
function dayOf(path: string): number | null {
  const m = path.match(/(?:^|\/)day-(\d+)(?:-|\.md$)/);
  return m ? Number(m[1]) : null;
}

/** Every link a record makes, as [from, to] — `links` entries and resolved wiki-links. */
function edgesOf(d: LibraryDocument): [string, string][] {
  return [...new Set([...d.links, ...wikilinks(d.body).map(target)])].map((to) => [d.path, to]);
}
const key = ([from, to]: [string, string]) => `${from} -> ${to}`;

test("the library is the size the demo promises", () => {
  expect(library.length).toBeGreaterThanOrEqual(400);
});

test("no library path collides with a fixture path or another library path", () => {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const d of library) {
    if (seen.has(d.path) || fixturePaths.has(d.path)) dupes.push(d.path);
    seen.add(d.path);
  }
  expect(dupes).toEqual([]);
});

test("every library module is deterministic", async () => {
  const names = [...new Bun.Glob("*.ts").scanSync({ cwd: LIBRARY_DIR })].sort();
  expect(names.length, "library source scan is nonempty").toBeGreaterThan(2);
  for (const name of names) {
    const text = (await Bun.file(join(LIBRARY_DIR, name)).text()).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const banned of ["Date.now()", "new Date(", "Math.random(", "fetch("]) expect(text.includes(banned), `${name} contains ${banned}`).toBe(false);
  }
});

test("the declared broken links are exactly the links that resolve to nothing", () => {
  const actual = library.flatMap(edgesOf).filter(([, to]) => !allPaths.has(to)).map(key).sort();
  expect(knownIssues.unresolved.length, "the mess declares broken links").toBeGreaterThan(0);
  expect(actual).toEqual(knownIssues.unresolved.map(key).sort());
});

// Degree zero over links that resolve, as the graph's maintenance view counts
// orphans: a record whose only link is broken has no edge, so it is one.
test("the declared orphans are exactly the records with no resolved link in or out", () => {
  const touched = new Set(library.flatMap((d) => edgesOf(d).flatMap(([from, to]) => (from === to || !allPaths.has(to) ? [] : [from, to]))));
  const actual = library.filter((d) => !touched.has(d.path)).map((d) => d.path).sort();
  expect(knownIssues.orphans.length, "the mess declares orphans").toBeGreaterThan(0);
  expect(actual).toEqual([...knownIssues.orphans].sort());
});

test("a bare-name wiki-link never names two records", () => {
  const wrong = library.flatMap((d) => wikilinks(d.body).map((raw) => raw.split("|")[0].split("#")[0].trim()).filter((text) => !text.includes("/") && ambiguous.has(text.toLowerCase())).map((text) => `${d.path}: [[${text}]]`));
  expect(wrong).toEqual([]);
});

for (const [name, domain] of Object.entries(libraryDomains)) {
  const mess = messDomains.includes(name);
  describe(`library: ${name}`, () => {
    const docs = domain.documents;

    test("paths sit under the domain's prefixes and end in .md", () => {
      const wrong = docs.filter((d) => !d.path.endsWith(".md") || !domain.prefixes.some((p) => d.path.startsWith(p)));
      expect(wrong.map((d) => d.path)).toEqual([]);
    });

    test("dates are ISO, ordered, and never after the reference date", () => {
      const wrong = docs.filter((d) => !ISO.test(d.created) || !ISO.test(d.updated) || d.created > d.updated || d.updated > REFERENCE_DATE);
      expect(wrong.map((d) => `${d.path} ${d.created} ${d.updated}`)).toEqual([]);
    });

    test("a day-numbered record is dated on its day", () => {
      const wrong = docs.flatMap((d) => {
        const day = dayOf(d.path);
        if (day === null) return [];
        return day < 1 || day > DAYS_SINCE_TROY || daysSince(TROY_FELL) - daysSince(d.created) !== day ? [`${d.path} created ${d.created}`] : [];
      });
      expect(wrong).toEqual([]);
    });

    if (mess) {
      test("a capture has a title and something written, and no heading for a title", () => {
        const wrong = docs.filter((d) => !d.title.trim() || d.body.trim().length < 40 || /^#\s/.test(d.body.trim()));
        expect(wrong.map((d) => d.path)).toEqual([]);
      });
    } else {
      test("every record has a title, a summary, a status, tags and a real body", () => {
        const wrong = docs.filter((d) => !d.title.trim() || !d.summary?.trim() || !d.type.trim() || !d.status?.trim() || !d.tags.length || d.tags.some((t) => !KEBAB.test(t)) || d.body.trim().length < 200 || /^#\s/.test(d.body.trim()));
        expect(wrong.map((d) => d.path)).toEqual([]);
      });

      test("every link and wiki-link resolves, every wiki-link is a full path listed in links, and there is at least one", () => {
        const wrong = docs.flatMap((d) => [
          ...(d.links.length ? [] : [`${d.path} has no links`]),
          ...d.links.filter((l) => !allPaths.has(l)).map((l) => `${d.path} -> ${l}`),
          ...wikilinks(d.body).filter((raw) => !raw.includes("/") || !allPaths.has(target(raw)) || !d.links.includes(target(raw))).map((raw) => `${d.path} -> [[${raw}]]`),
        ]);
        expect(wrong).toEqual([]);
      });
    }

    test("every person and place a record names exists", () => {
      const wrong = docs.flatMap((d) => [...(d.people ?? []).filter((id) => !personIds.has(id)), ...(d.places ?? []).filter((id) => !placeIds.has(id))].map((id) => `${d.path} ${id}`));
      expect(wrong).toEqual([]);
    });

    test("contact details use reserved identifiers only", () => {
      const wrong = docs.flatMap((d) => {
        const text = `${d.body} ${Object.values(d.fields ?? {}).join(" ")}`;
        const phones = [...text.matchAll(/\b\d{3}-\d{4}\b/g)].map((m) => m[0]).filter((p) => !/^555-01\d\d$/.test(p));
        const emails = [...text.matchAll(/[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g)].filter((m) => m[1] !== "example.com").map((m) => m[0]);
        const hosts = [...text.matchAll(/https?:\/\/([^/\s)]+)/g)].filter((m) => m[1] !== "example.com" && !m[1].endsWith(".invalid")).map((m) => m[0]);
        return [...phones, ...emails, ...hosts].map((x) => `${d.path} ${x}`);
      });
      expect(wrong).toEqual([]);
    });
  });
}

describe("library: the crew ledger closes", () => {
  test("twelve ships, numbered once each, each with a record", () => {
    expect(shipRecords.length).toBe(shipsEmbarked);
    expect(shipRecords.map((s) => s.ship).sort((a, b) => a - b)).toEqual(Array.from({ length: shipsEmbarked }, (_, i) => i + 1));
    expect(shipRecords.filter((s) => !libraryPaths.has(s.path)).map((s) => s.path)).toEqual([]);
  });

  test("each ship's record states the roster it closes on", () => {
    const wrong = shipRecords.flatMap((s) => {
      const doc = library.find((d) => d.path === s.path)!;
      const lost = Object.values(s.lost).reduce((a, n) => a + n, 0);
      // The roster table: Day | Where | Lost | Aboard, oldest first.
      const rows = doc.body.split("\n").filter((line) => /^\|\s*\d/.test(line)).map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
      const tableLost = rows.reduce((a, r) => a + (Number(r[2]) || 0), 0);
      const problems = [
        doc.fields?.ship !== s.ship && "fields.ship",
        doc.fields?.embarked !== s.embarked && "fields.embarked",
        doc.fields?.lost !== lost && "fields.lost",
        rows.length < 2 && "no roster table",
        Number(rows[0]?.[3]) !== s.embarked && "first aboard count",
        Number(rows.at(-1)?.[3]) !== s.embarked - lost && "last aboard count",
        tableLost !== lost && "table losses",
      ].filter(Boolean);
      return problems.length ? [`${s.path}: ${problems.join(", ")}`] : [];
    });
    expect(wrong).toEqual([]);
  });

  test("rosters embark the ledger's crew", () => {
    expect(shipRecords.reduce((a, s) => a + s.embarked, 0)).toBe(crewEmbarked);
  });

  test("losses by place equal the ledger, and no ship loses more than it carried", () => {
    const byPlace: Record<string, number> = {};
    for (const s of shipRecords) {
      for (const [place, n] of Object.entries(s.lost)) byPlace[place] = (byPlace[place] ?? 0) + n;
      expect(Object.values(s.lost).reduce((a, n) => a + n, 0), `ship ${s.ship}`).toBe(s.embarked);
    }
    expect(byPlace).toEqual(Object.fromEntries(crewLosses.map((l) => [l.place, l.lost])));
  });
});
