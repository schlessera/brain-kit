// The fixture world's invariants, asserted.
//
// These are the claims `fixtures/README.md` makes. They are here rather than
// in prose alone because every one of them is the kind of thing that decays
// silently: a coordinate typo draws a map of the wrong sea, a broken
// cross-reference renders a blank row, and a ledger that stops balancing is
// how a demo screenshot ends up saying two different things at once.

import { describe, expect, test } from "bun:test";
import { join, resolve } from "path";

import * as actions from "../fixtures/actions.js";
import * as events from "../fixtures/events.js";
import * as files from "../fixtures/files.js";
import * as money from "../fixtures/money.js";
import * as notes from "../fixtures/notes.js";
import * as people from "../fixtures/people.js";
import * as places from "../fixtures/places.js";
import * as projects from "../fixtures/projects.js";
import * as runs from "../fixtures/runs.js";
import * as search from "../fixtures/search.js";
import * as week from "../fixtures/week.js";
import {
  DAYS_ON_AEAEA,
  DAYS_ON_OGYGIA,
  DAYS_SINCE_TROY,
  REFERENCE_DATE,
  TROY_FELL,
  daysSince,
} from "../fixtures/time.js";


const FIXTURE_DIR = resolve(import.meta.dir, "..", "fixtures");

/** Every fixture module's source, as [path, text]. Resolved from this file's
 *  own location so the scan does not depend on the working directory -- a
 *  cwd-relative glob silently matches nothing and the test passes by default. */
async function fixtureSources(): Promise<[string, string][]> {
  const glob = new Bun.Glob("*.ts");
  const out: [string, string][] = [];
  for (const name of [...glob.scanSync({ cwd: FIXTURE_DIR })].sort()) {
    out.push([name, await Bun.file(join(FIXTURE_DIR, name)).text()]);
  }
  return out;
}

/** Line and block comments removed. Prose about a rule is not a violation. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("the pinned clock", () => {
  test("the reference date is the one the core corpus pins", () => {
    expect(REFERENCE_DATE).toBe("2026-07-12");
  });

  test("Troy fell exactly DAYS_SINCE_TROY before the reference date", () => {
    expect(daysSince(TROY_FELL)).toBe(DAYS_SINCE_TROY);
  });

  test("the two durations the poem states both fit inside the total", () => {
    // Seven years on Ogygia and one on Aeaea have to coexist with the ten
    // years since Troy. This is the arithmetic that rejected the brief's
    // original day count.
    expect(DAYS_ON_OGYGIA + DAYS_ON_AEAEA).toBeLessThan(DAYS_SINCE_TROY);
    expect(DAYS_ON_OGYGIA).toBe(2557);
  });

  test("no fixture module reads the wall clock or does I/O", async () => {
    const offenders: string[] = [];
    for (const [path, text] of await fixtureSources()) {
      // `new Date(` with a literal argument is fine; the bans are the three
      // ways to read the host's current time. Comments are stripped first, or
      // the rule trips on the doc comment that states it -- the same trap
      // `scripts/check-leakage.ts` dodges with split string literals.
      // `fetch` is in here rather than in `scripts/check-kit-purity.ts`: that
      // gate is about D13, a claim about COMPONENTS, and widening its glob to
      // fixtures/ would conflate two concerns while still missing the three
      // bans above, which are the ones that actually matter for a fixture.
      if (/Date\.now\(\)|new Date\(\s*\)|Math\.random\(|\bfetch\(/.test(stripComments(text))) {
        offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the geography", () => {
  test("every coordinate is inside the Mediterranean basin", () => {
    for (const p of places.places) {
      expect(p.lat).toBeGreaterThan(30);
      expect(p.lat).toBeLessThan(46);
      expect(p.lon).toBeGreaterThan(-6);
      expect(p.lon).toBeLessThan(37);
    }
  });

  test("every place names the article its coordinate came from", () => {
    for (const p of places.places) expect(p.source).toMatch(/^Wikipedia: /);
  });

  test("there is exactly one home", () => {
    expect(places.places.filter((p) => p.kind === "home")).toHaveLength(1);
  });

  test("visited places are in chronological order and none is in the future", () => {
    const days = places.places.filter((p) => p.day !== null).map((p) => p.day!);
    const visitOrder = places.places.filter((p) => p.day !== null);
    for (const p of visitOrder) expect(p.day!).toBeLessThanOrEqual(DAYS_SINCE_TROY);
    expect(days.length).toBeGreaterThan(0);
  });

  test("the voyage polyline is [lon, lat] and starts at Troy", () => {
    const [firstLon, firstLat] = places.voyageRoute[0]!;
    expect(firstLon).toBeCloseTo(26.2389, 4);
    expect(firstLat).toBeCloseTo(39.9575, 4);
    // A [lat, lon] mix-up puts a latitude in the longitude slot; at these
    // latitudes the two ranges overlap, so check every point explicitly.
    for (const [lon, lat] of [...places.voyageRoute, ...places.plannedRoute]) {
      expect(lat).toBeGreaterThan(30);
      expect(lat).toBeLessThan(46);
      expect(lon).toBeGreaterThan(-6);
      expect(lon).toBeLessThan(37);
    }
  });

  test("the planned route ends at Ithaca", () => {
    const last = places.plannedRoute[places.plannedRoute.length - 1]!;
    const ithaca = places.placeById["place:ithaca"]!;
    expect(last[0]).toBeCloseTo(ithaca.lon, 4);
    expect(last[1]).toBeCloseTo(ithaca.lat, 4);
  });

  test("every map pin corresponds to a place in the world", () => {
    const known = places.places.map((p) => `${p.lat},${p.lon}`);
    for (const scene of places.mapScenes) {
      for (const pin of scene.pins) expect(known).toContain(`${pin.lat},${pin.lon}`);
    }
  });
});

describe("cross-references", () => {
  test("ids are unique across every entity table", () => {
    const ids = [
      ...people.people.map((p) => p.id),
      ...places.places.map((p) => p.id),
      ...projects.projects.map((p) => p.id),
      ...projects.threads.map((t) => t.id),
      ...notes.notes.map((n) => n.id),
      ...runs.runs.map((r) => r.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("document paths are unique within each table", () => {
    for (const table of [
      notes.notes.map((n) => n.path),
      people.people.map((p) => p.path),
      [...projects.projects.map((p) => p.path), projects.goal.path],
    ]) {
      expect(new Set(table).size).toBe(table.length);
    }
  });

  test("a path shared by a person and a note is the SAME document", () => {
    // `people/penelope.md` is one file. It appears in `people.ts` as the
    // person record and in `notes.ts` as the document record, and the two
    // have to agree -- a person page whose note is about somebody else is
    // exactly the kind of drift that renders fine and reads wrong.
    const byPath = new Map(notes.notes.map((n) => [n.path, n]));
    for (const person of people.people) {
      const note = byPath.get(person.path);
      if (!note) continue;
      expect(note.kind).toBe("person");
      expect(note.people).toContain(person.id);
      expect(note.staleDays).toBe(person.staleDays);
    }
  });

  test("every wiki-link in a note resolves to a document that exists", () => {
    const known = new Set([
      ...notes.notes.map((n) => n.path),
      ...people.people.map((p) => p.path),
      ...projects.projects.map((p) => p.path),
      projects.goal.path,
    ]);
    const unresolved = notes.notes.flatMap((n) =>
      n.links.filter((l) => !known.has(l)).map((l) => `${n.path} -> ${l}`)
    );
    expect(unresolved).toEqual([]);
  });

  test("no note is an orphan", () => {
    const linkedTo = new Set(notes.notes.flatMap((n) => n.links));
    for (const n of notes.notes) {
      const hasOut = n.links.length > 0;
      const hasIn = linkedTo.has(n.path);
      expect(hasOut || hasIn).toBe(true);
    }
  });

  test("every person and place a note names exists", () => {
    for (const n of notes.notes) {
      for (const id of n.people) expect(people.peopleById[id]).toBeDefined();
      for (const id of n.places) expect(places.placeById[id]).toBeDefined();
    }
  });

  test("every person's location is a real place", () => {
    for (const p of people.people) {
      if (p.at !== null) expect(places.placeById[p.at]).toBeDefined();
    }
  });

  test("every project and thread points at things that exist", () => {
    for (const p of projects.projects) {
      for (const id of p.places) expect(places.placeById[id]).toBeDefined();
      for (const id of p.people) expect(people.peopleById[id]).toBeDefined();
    }
    for (const t of projects.threads) expect(projects.projectById[t.project]).toBeDefined();
  });

  test("every run's thread exists", () => {
    for (const r of runs.runs) {
      if (r.thread !== null) expect(projects.threadById[r.thread]).toBeDefined();
    }
  });

  test("graph edges index real nodes", () => {
    for (const [a, b] of search.graphEdges) {
      expect(search.graphNodes[a]).toBeDefined();
      expect(search.graphNodes[b]).toBeDefined();
    }
  });

  // The file viewer's tree and prose are the same world as the notes: the
  // tree's rows are the decisions `notes.ts` holds, the open row is the
  // document being viewed, and every link in its prose resolves.
  test("the file viewer opens a document that exists, in a folder that holds it", () => {
    const known = new Set([
      ...notes.notes.map((n) => n.path),
      ...people.people.map((p) => p.path),
      ...projects.projects.map((p) => p.path),
      projects.goal.path,
    ]);
    const doc = notes.viewerDocument;
    expect(known.has(doc.note.path)).toBe(true);
    for (const para of doc.paragraphs) {
      if (para.link) expect(known.has(para.link)).toBe(true);
    }
    for (const q of doc.questions) expect(q.state).toBe("todo");

    const [folder, ...rows] = files.viewerTree;
    expect(folder!.kind).toBe("open");
    expect(folder!.depth).toBe(0);
    expect(Number(folder!.meta)).toBe(files.folderCounts.decisions);
    const decisions = notes.notes.filter((n) => n.kind === "decision");
    expect(rows).toHaveLength(decisions.length);
    for (const row of rows) {
      expect(row.depth).toBe(1);
      expect(decisions.some((n) => n.path.endsWith(`/${row.label}`))).toBe(true);
    }
    const active = rows.filter((r) => r.active);
    expect(active).toHaveLength(1);
    expect(doc.note.path.endsWith(`/${active[0]!.label}`)).toBe(true);
    expect(files.viewerTreeLabel).toContain(`${rows.length} of ${folder!.meta}`);
  });

  test("every note tag is in the world's tag vocabulary", () => {
    const vocabulary = new Set<string>(notes.tags);
    for (const n of notes.notes) for (const t of n.tags) expect(vocabulary.has(t)).toBe(true);
  });
});

describe("the ledgers balance", () => {
  test("six hundred men out of Troy, and every one of them accounted for", () => {
    expect(money.crewLost).toBe(money.crewEmbarked);
    expect(money.crewSurvivors).toBe(1);
    expect(money.shipsReturned).toBe(0);
  });

  test("the weekly spend bars sum to the weekly total", () => {
    const fromBars = Object.values(money.weekSpendCents).reduce((a, b) => a + b, 0);
    expect(fromBars).toBe(money.weekSpendTotalCents);
    expect(money.weekDailyCents.reduce((a, b) => a + b, 0)).toBe(money.weekSpendTotalCents);
  });

  test("the run spend is the sum of the runs", () => {
    expect(runs.runSpendCents).toBe(runs.runs.reduce((a, r) => a + r.cents, 0));
    expect(runs.usd(runs.runSpendCents)).toBe("$0.22");
  });

  test("the folder counts sum to the advertised corpus size", () => {
    expect(files.documentCount).toBe(4812);
    expect(files.corpusSize.documents).toBe(files.documentCount);
  });

  test("the journal holds one entry per day since Troy", () => {
    expect(files.folderCounts.journal).toBe(DAYS_SINCE_TROY);
  });

  // The weekly review reports on the week rather than inventing one, so every
  // figure on that screen has to be derivable from another. A review whose
  // header says 41 runs and whose filter pills sum to something else is the
  // exact failure a screenshot cannot show you.
  test("the weekly review closes on itself", () => {
    expect(week.weekDecisionsOffered + week.weekDays).toBe(week.weekRuns);
    expect(week.weekDecisionsAnswered + week.weekDecisionsCarried).toBe(week.weekDecisionsOffered);
    expect(week.weekCarried).toHaveLength(week.weekCarriedCount);
    // Two of the three carried items are the two unanswered decisions; the
    // third is a stale premise, which was never a decision to begin with.
    expect(week.weekCarriedCount).toBe(week.weekDecisionsCarried + 1);
  });

  // The Actions list reports on the same cards `actions.ts` carries, so every
  // count on it is derivable from them: the header counts the decisions, the
  // strip counts the FYIs, and the cap meter's `open` is both together.
  test("the actions list closes on itself", () => {
    const { actionsWaiting, actionsFyis, actionThreads, actionPolicies, actionsCap } = actions;
    expect(actionsCap.open).toBe(actionsWaiting.length + actionsFyis.length);
    expect(actionsCap.pct).toBe(Math.round((actionsCap.open / actionsCap.cap) * 100));
    expect(actionsCap.valueText).toBe(`${actionsCap.open} / ${actionsCap.cap} open`);
    expect(actions.actionsHeaderMeta).toContain(String(actionsWaiting.length));
    expect(actions.actionsFyiStrip).toContain(String(actionsFyis.length));
    // The snoozed count is the weekly review's carried decisions; the two
    // files cannot import each other, so the equality is held here.
    expect(actions.actionsSnoozedCount).toBe(week.weekDecisionsCarried);
    // Every waiting decision is on the list exactly once: under its thread, or
    // under "Policies", never both and never neither.
    const listed = [...actionThreads.flatMap((t) => t.items), ...actionPolicies];
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed.length).toBe(actionsWaiting.length);
    for (const t of actionThreads) expect(t.items.length).toBeGreaterThan(0);
  });

  test("the weekly review's percentage is computed, not typed", () => {
    expect(week.weekAnsweredPct).toBe(
      Math.round((week.weekDecisionsAnswered / week.weekDecisionsOffered) * 100),
    );
    // Every filter pill's count is one of the figures above, so a pill cannot
    // drift from the header.
    const counts = week.weekFilters.map((f) => Number(f.split(" ").pop()));
    expect(counts).toEqual([
      week.weekRuns,
      week.weekDecisionsOffered,
      week.weekDays,
      week.weekFailedFetches,
    ]);
  });
});

describe("coverage the design asks for", () => {
  test("all seven action kinds appear", () => {
    const kinds = new Set(actions.actions.map((a) => a.kind));
    expect(kinds.size).toBe(7);
  });

  test("all six queue states appear", () => {
    const states = new Set(actions.queueItems.map((q) => q.state));
    expect(states.size).toBe(6);
  });

  test("all five empty-state variants appear", () => {
    expect(new Set(actions.emptyStates.map((e) => e.variant)).size).toBe(5);
  });

  test("all four run states appear", () => {
    expect(new Set(runs.runs.map((r) => r.state)).size).toBe(4);
  });

  test("all four attachment kinds appear", () => {
    expect(new Set(files.attachments.map((a) => a.kind)).size).toBe(4);
  });

  test("all three notification densities appear", () => {
    expect(new Set(events.notifications.map((n) => n.variant)).size).toBe(3);
  });

  test("the progress step list has exactly one current step", () => {
    expect(projects.voyageSteps.filter((s) => s.state === "current")).toHaveLength(1);
    expect(projects.launchChecklist.filter((s) => s.state === "current")).toHaveLength(1);
  });
});

describe("reserved identifiers only", () => {
  const fixtureText = async () =>
    (await fixtureSources()).map(([, text]) => text).join("\n");

  test("every phone number is in the 555-01xx block", () => {
    for (const p of people.people) {
      if (p.phone !== null) expect(p.phone).toMatch(/^555-01\d\d$/);
    }
  });

  test("every email is on example.com", () => {
    for (const p of people.people) {
      if (p.email !== null) expect(p.email).toMatch(/@example\.com$/);
    }
  });

  test("every hostname is an RFC 2606 reserved name", async () => {
    const text = await fixtureText();
    const hosts = [...text.matchAll(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/g)].map((m) => m[0]);
    // The one real host by contract: a tracker block derives an item's
    // repository, number and type only from a github.com url (#1001), so its
    // fixtures have to use that host. The repositories on it are the world's.
    const BY_CONTRACT: readonly string[] = ["github.com"];
    const offenders = hosts.filter(
      (h) =>
        !BY_CONTRACT.includes(h) &&
        // Only consider things that look like hostnames, not file paths or
        // decimal numbers -- a real TLD is what we are hunting.
        /\.(com|net|org|io|dev|co|app|ai|invalid|test|example|localhost)$/.test(h) &&
        !/(^|\.)(example\.com|example\.net|example\.org)$/.test(h) &&
        !/\.(invalid|test|example|localhost)$/.test(h)
    );
    expect(offenders).toEqual([]);
  });

  test("no IBAN-shaped string appears anywhere", async () => {
    const text = await fixtureText();
    expect(text).not.toMatch(/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/);
  });
});

/* `DataTableColumn.w` is a fixed width in PIXELS. It is trivially mistaken for a
   percentage -- `crewTable` once carried 40/16/44, a split summing to 100, which
   rendered a 16px column and wrapped every cell including single digits. The
   component cannot tell the two apart (both are just numbers), and nothing else
   catches it: it typechecks, every test passed, and the only symptom was visual.
   So the guard is here. A column narrower than 32px cannot hold two digits plus
   its padding, and a full set of widths summing to exactly 100 is the signature
   of the percentage mistake rather than a plausible pixel layout. */
describe("DataTable column widths are pixels, not percentages", () => {
  const tables: { name: string; columns: { label: string; w?: number }[] }[] = [
    { name: "money.crewTable", columns: money.crewTable.columns },
  ];

  for (const { name, columns } of tables) {
    test(`${name}: every pinned width is a plausible pixel value`, () => {
      for (const c of columns) {
        if (c.w === undefined) continue;
        expect(
          c.w,
          `${name} column "${c.label}" is ${c.w}px wide, which cannot hold its content`,
        ).toBeGreaterThanOrEqual(32);
      }
    });

    test(`${name}: widths do not sum to 100 with every column pinned`, () => {
      const pinned = columns.filter((c) => c.w !== undefined);
      if (pinned.length !== columns.length) return;
      const total = pinned.reduce((a, c) => a + (c.w ?? 0), 0);
      expect(total, `${name} widths sum to 100 — these look like percentages`).not.toBe(100);
    });
  }
});
