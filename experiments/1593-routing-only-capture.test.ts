import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
import { openDatabase } from "../packages/core/src/lib/db";
import { buildTaxonomy } from "../packages/core/src/lib/taxonomy";
import { stringifyDocument } from "../packages/core/src/lib/frontmatter";
import type { JevAnswers } from "../packages/core/src/lib/jev";
import { calibrate, parseTags, route, scoreWrite, writeCapture, type Case, type Doc } from "../evals/1593-routing-only-capture/route";

const config = { taxonomy: { types: { project: { dir: "projects", appendMatch: true }, network: { dir: "network", appendMatch: true }, ritual: { dir: "rituals" }, opinion: { dir: "opinions" } } } };
const taxonomy = buildTaxonomy({ user: config });
const types = ["note", "context", "project", "network", "ritual", "opinion"];
const raft: Doc = { path: "projects/raft.md", type: "project", title: "Raft repair", tags: ["sailing"], body: "Preserve the old mast." };
const penelope: Doc = { path: "network/penelope.md", type: "network", title: "Penelope", tags: ["weaving"], body: "Keeps the loom." };
const sirens: Doc = { path: "rituals/sirens.md", type: "ritual", title: "Passing the Sirens", tags: ["sirens"], body: "Wax the ears." };
const shortlist = [raft, penelope];
const choice = (choice: string, confidence: number) => ({ type: "choice", choice, confidence, probabilities: {} }) as unknown as JevAnswers[string];
const answers = (type: [string, number], target: [string, number]): JevAnswers => ({ type: choice(...type), target: choice(...target) });
const floors = { type: 0.6, target: 0.6 };

test("an exact append-match title routes in code, overriding a confident Jev none", () => {
  const r = route("Raft repair\nThe lashings held.", answers(["note", 1], ["none", 1]), floors, shortlist, types);
  expect(r).toMatchObject({ type: "project", target: "projects/raft.md", decidedBy: { target: "exact-title", type: "target" } });
});

test("the exact title of a non-append record never becomes a target", () => {
  const r = route("Passing the Sirens\nThe wax held.", answers(["note", 0.9], ["none", 0.9]), floors, shortlist, types);
  expect(r.target).toBeNull();
  expect(r.type).toBe("note");
});

test("below-floor judgments fall back to the inbox note and no target, and count as abstentions", () => {
  const r = route("Penelope's loom creaks.", answers(["opinion", 0.59], ["network/penelope.md", 0.59]), floors, shortlist, types);
  expect(r).toMatchObject({ type: "note", target: null, abstentions: 2 });
});

test("type and target floors apply separately", () => {
  const r = route("Penelope finished a panel.", answers(["opinion", 0.5], ["network/penelope.md", 0.5]), { type: 0.9, target: 0.4 }, shortlist, types);
  expect(r).toMatchObject({ type: "network", target: "network/penelope.md", abstentions: 0 });
});

test("an explicit type request refuses an append target of another type", () => {
  const r = route("Capture as opinion. The raft repair is overdue.", answers(["project", 1], ["projects/raft.md", 1]), floors, shortlist, types);
  expect(r).toMatchObject({ type: "opinion", target: null, decidedBy: { target: "explicit-type" } });
});

test("a Jev target outside the shortlist is not used", () => {
  const r = route("We passed the Sirens again.", answers(["note", 1], [sirens.path, 1]), floors, shortlist, types);
  expect(r.target).toBeNull();
});

test("calibration takes the safest best target floor, then the lowest best type floor", () => {
  const c = (id: string, content: string, type: string, target: string | null): Case => ({ id, split: "tuning", content, expected: { type, target, tags: [] } });
  const tuning = [
    // A confident correct target, a weakly confident wrong target, and a weakly confident correct type.
    { c: c("a", "Penelope finished a panel.", "network", penelope.path), answers: answers(["network", 0.9], [penelope.path, 0.9]) },
    { c: c("b", "Someone mentioned the raft.", "note", null), answers: answers(["note", 0.3], [raft.path, 0.3]) },
    { c: c("c", "Weave daily.", "ritual", null), answers: answers(["ritual", 0.3], ["none", 0.9]) },
  ];
  const r = calibrate(tuning, shortlist, types, [0, 0.2, 0.4, 0.6, 0.95]);
  expect(r.target.find((t) => t.floor === 0.2)).toMatchObject({ wrong: 1 });
  expect(r.frozen).toEqual({ target: 0.6, type: 0 });
});

test("the tag handoff contributes only tags; a proposed target or type is ignored", () => {
  expect(parseTags('```json\n{"tags":["Sailing"," sailing"],"target":"network/penelope.md","type":"ritual"}\n```')).toEqual({ tags: ["sailing"], invalid: false });
  expect(parseTags('{"tags":"sailing"}')).toEqual({ tags: [], invalid: true });
  expect(parseTags("APPROVED")).toEqual({ tags: [], invalid: true });
});

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function brain() {
  const root = mkdtempSync(join(tmpdir(), "routing-1593-"));
  roots.push(root);
  writeFileSync(join(root, "brain.config.json"), JSON.stringify(config));
  for (const d of [raft, sirens]) {
    mkdirSync(join(root, d.path, ".."), { recursive: true });
    writeFileSync(join(root, d.path), stringifyDocument(`\n${d.body}\n`, { type: d.type, title: d.title, tags: d.tags }));
  }
  return { root, db: openDatabase(join(root, "brain.db")) };
}

test("the writer appends after the unchanged old body and retains its tags", async () => {
  const { root, db } = brain();
  const old = readFileSync(join(root, raft.path), "utf8");
  try { await writeCapture("The lashings held.", { type: "project", target: raft.path, tags: ["weaving"] }, { root, db, taxonomy, shortlist, date: "2026-07-12" }); } finally { db.close(); }
  const after = readFileSync(join(root, raft.path), "utf8");
  expect(parseFrontmatter(after).content).toBe(`${parseFrontmatter(old).content.replace(/\n*$/, "\n\n")}## 2026-07-12 Update\n\nThe lashings held.\n`);
  expect(parseFrontmatter(after).data.tags).toEqual(["sailing"]);
});

test("the writer refuses a target outside the shortlist and creates a new capture instead", async () => {
  const { root, db } = brain();
  const old = readFileSync(join(root, sirens.path), "utf8");
  let result;
  try { result = await writeCapture("The wax held.", { type: "note", target: sirens.path, tags: [] }, { root, db, taxonomy, shortlist, date: "2026-07-12" }); } finally { db.close(); }
  expect(readFileSync(join(root, sirens.path), "utf8")).toBe(old);
  expect(result).toMatchObject({ action: "created", refusedTarget: sirens.path });
});

test("a new capture keeps an empty selected tag set rather than keyword tags", async () => {
  const { root, db } = brain();
  let result;
  try { result = await writeCapture("Sailing sailing sailing near the mast.", { type: "note", target: null, tags: [] }, { root, db, taxonomy, shortlist, date: "2026-07-12" }); } finally { db.close(); }
  expect(parseFrontmatter(readFileSync(join(root, result.path), "utf8")).data.tags).toEqual([]);
});

test("scoring vetoes a wrong-target append even when the capture text is preserved", () => {
  const before = { [raft.path]: stringifyDocument("\nPreserve the old mast.\n", { type: "project", title: "Raft repair" }) };
  const after = { [raft.path]: before[raft.path] + "\nThe mast casts a shadow.\n" };
  const r = scoreWrite("The mast casts a shadow.", { type: "note", target: null, tags: [] }, before, after, (t) => taxonomy.isValidType(t));
  expect(r.wrongTarget).toBe(true);
  expect(r.contentLoss).toBe(false);
});
