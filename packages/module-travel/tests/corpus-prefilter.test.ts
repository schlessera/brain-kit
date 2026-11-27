/** Travel reads parse only files that could be travel documents, and the places registry is one pass (#4791). */
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import * as frontmatter from "@schlessera/brain-common/internal/frontmatter";
import { cleanup, makeTempBrain, runCli } from "../../core/tests/cli-harness.js";
import { readTravelCorpus, summarizeAllPlaceVisits, summarizePlaceVisits, type TravelCorpus, type TravelDocument } from "../src/content.js";
import { renderPlaces } from "../src/sync.js";

const FRONTMATTER = "@schlessera/brain-common/internal/frontmatter";
const original = { ...frontmatter };
const parsed: string[] = [];
beforeAll(() => {
  mock.module(FRONTMATTER, () => ({
    ...original,
    parseFrontmatter: (source: string, options?: unknown) => {
      parsed.push(source);
      return (original.parseFrontmatter as (source: string, options?: unknown) => unknown)(source, options);
    },
  }));
});
afterAll(() => { mock.module(FRONTMATTER, () => original); });

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function brainDir(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "travel-prefilter-"));
  dirs.push(root);
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}

const TRIP = "---\ntype: trip\ntitle: Headland walk\ntrip_status: proposed\n---\nOdysseus walks the headland.\n";
const PLACE = "---\ntype: place\ntitle: Ithaca\nplace_kind: country\n---\n";
const JOURNEY = "---\ntype: travel\ntitle: Homecoming\n---\n";
const note = (i: number): string => `---\ntype: note\ntitle: Suitor ledger ${i}\ncreated: 2026-07-12\n---\nPenelope counts the suitors.\n`;

test("only the travel documents among 203 files are parsed", () => {
  const files: Record<string, string> = { "trips/headland.md": TRIP, "places/ithaca.md": PLACE, "travel/homecoming.md": JOURNEY };
  for (let i = 0; i < 200; i++) files[`notes/ledger-${i}.md`] = note(i);
  const root = brainDir(files);
  parsed.length = 0;
  const corpus = readTravelCorpus(root);
  expect([...corpus.documents.keys()].sort()).toEqual(["places/ithaca.md", "travel/homecoming.md", "trips/headland.md"]);
  expect(corpus.issues).toEqual([]);
  expect(parsed.filter((source) => source.includes("Suitor ledger"))).toEqual([]);
  expect(new Set(parsed)).toEqual(new Set([TRIP, PLACE, JOURNEY]));
});

describe("malformed frontmatter", () => {
  const brokenTrip = "---\ntype: trip\ntitle: [unclosed\n---\n";
  const brokenNote = "---\ntype: note\ntitle: [unclosed\n---\n";

  test("a malformed trip is still a travel issue; a malformed note without a travel word is not", () => {
    const corpus = readTravelCorpus(brainDir({ "trips/broken.md": brokenTrip, "notes/broken.md": brokenNote, "places/ithaca.md": PLACE }));
    expect(corpus.issues.map((issue) => issue.file)).toEqual(["trips/broken.md"]);
  });

  const roots: string[] = [];
  afterAll(() => { for (const root of roots) cleanup(root); });
  test("the malformed note does not stop brain travel sync, and brain validate still reports it", async () => {
    const root = makeTempBrain({ empty: true });
    roots.push(root);
    writeFileSync(join(root, "brain.config.json"), JSON.stringify({ modules: { "@schlessera/brain-module-travel": {} } }) + "\n");
    mkdirSync(join(root, "notes"), { recursive: true });
    writeFileSync(join(root, "notes/broken.md"), brokenNote);
    const sync = await runCli(root, ["travel", "sync", "--json"]);
    expect(sync.code).toBe(0);
    expect(JSON.parse(sync.stdout).sync.files.length).toBeGreaterThan(0);
    const validate = await runCli(root, ["validate", "--json"]);
    expect(validate.stdout).toContain("notes/broken.md");
  });
});

describe("a trip is found however its type is written", () => {
  const rows: Array<[string, string]> = [
    ["plain", "---\ntype: trip\ntitle: Headland\ntrip_status: proposed\n---\n"],
    ["double-quoted", "---\ntype: \"trip\"\ntitle: Headland\ntrip_status: proposed\n---\n"],
    ["single-quoted", "---\ntype: 'trip'\ntitle: Headland\ntrip_status: proposed\n---\n"],
    ["escaped", "---\ntype: \"\\x74rip\"\ntitle: Headland\n\"\\x74rip_status\": proposed\n---\n"],
    ["anchor and alias", "---\nkind: &kind trip\ntype: *kind\ntitle: Headland\ntrip_status: proposed\n---\n"],
    ["flow mapping", "---\n{type: trip, title: Headland, trip_status: proposed}\n---\n"],
    ["byte order mark", "\ufeff---\ntype: trip\ntitle: Headland\ntrip_status: proposed\n---\n"],
  ];
  for (const [name, source] of rows) test(name, () => {
    const corpus = readTravelCorpus(brainDir({ "outings/headland.md": source }));
    expect(corpus.issues).toEqual([]);
    expect(corpus.documents.get("outings/headland.md")?.type).toBe("trip");
  });
});

/** A corpus whose visit objects count every property read. */
function countedCorpus(placeCount: number, visitCount: number): { corpus: TravelCorpus; reads: () => number } {
  let reads = 0;
  const documents = new Map<string, TravelDocument>();
  const placePaths = Array.from({ length: placeCount }, (_, i) => `places/spot-${String(i).padStart(2, "0")}.md`);
  documents.set("places/ithaca.md", { type: "place", title: "Ithaca", place_kind: "country" } as TravelDocument);
  for (const path of placePaths) {
    documents.set(path, { type: "place", title: path, place_kind: "spot", parent_place: "places/ithaca.md" } as TravelDocument);
  }
  for (let t = 0; t < 10; t++) {
    const visits = Array.from({ length: visitCount / 10 }, (_, v) => new Proxy({
      id: `visit-${v}`, date: v % 7 === 0 ? null : `2026-07-${String(1 + (v % 28)).padStart(2, "0")}`,
      places: [placePaths[(t * 20 + v) % placeCount]!],
    }, { get(target, key, receiver) { reads++; return Reflect.get(target, key, receiver); } }));
    documents.set(`trips/trip-${t}.md`, { type: "trip", title: `Trip ${t}`, trip_status: "done", visits } as TravelDocument);
  }
  // One visit referenced from both a place and its trip.
  (documents.get(placePaths[0]!) as { visits?: unknown }).visits = [{ document: "trips/trip-0.md", visit: "visit-0" }];
  return { corpus: { documents, issues: [] }, reads: () => reads };
}

test("rendering the places registry examines each visit a bounded number of times", () => {
  const { corpus, reads } = countedCorpus(50, 200);
  renderPlaces(corpus, "places/_index.md");
  expect(reads()).toBeLessThan(200 * 12);
});

test("the one-pass summaries equal one summarizePlaceVisits per place", () => {
  const { corpus } = countedCorpus(50, 200);
  const paths = [...corpus.documents].filter(([, document]) => document.type === "place").map(([path]) => path);
  expect(summarizeAllPlaceVisits(corpus, paths)).toEqual(new Map(paths.map((path) => [path, summarizePlaceVisits(corpus, path)])));
});
