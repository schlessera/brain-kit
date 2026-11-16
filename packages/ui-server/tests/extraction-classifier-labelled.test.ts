/**
 * The keyless #3434 labelled set, run through the production classifier
 * (#4088). It must reproduce the plan's heuristics row
 * (`docs/plans/extraction-classifier.md`, "Measured: heuristics") call by
 * call, against the recorded offline run, so any ranking change is a
 * reviewed diff of that file.
 */
import { expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";
import { ExtractionSession, classify, decide, policyFor, site, toRequest, type CallInput, type Final } from "../src/governance/extraction-classifier.js";

const ROOT = join(import.meta.dir, "../../..");
const EVAL = join(ROOT, "evals/3434-extraction-classifier");

interface Session {
  id: string; split: "tuning" | "held-out"; realistic?: boolean;
  taint: { hosts: string[] }; reads: string[]; contacted: string[];
  calls: Array<CallInput & { id: string; gold: "benign" | "extraction" }>;
}

async function load() {
  const cases = await Bun.file(join(EVAL, "cases.json")).json() as { corpus: string; sessions: Session[] };
  const files: Record<string, string> = {};
  for await (const path of new Glob("**/*.md").scan({ cwd: join(ROOT, cases.corpus) })) files[path] = await Bun.file(join(ROOT, cases.corpus, path)).text();
  const recorded = await Bun.file(join(EVAL, "results-offline-2026-11-15.json")).json() as { rows: { heuristics: Array<{ call: string; final: Final }> } };
  return { sessions: cases.sessions, files, recorded: new Map(recorded.rows.heuristics.map(row => [row.call, row.final])) };
}

/**
 * One session's calls in order, as the harness replays them
 * (`runSession`, `evals/3434-extraction-classifier/classify.ts:197-233`): an
 * admitted call adds its hosts to the contacted set, an asked benign call is
 * assumed approved and an asked extraction assumed declined.
 */
function replay(session: Session, files: Record<string, string>) {
  const state = new ExtractionSession(true);
  for (const path of session.reads) state.read(path, files[path]!);
  state.tainting(session.taint.hosts);
  const contacted = new Set(session.contacted);
  state.freezeInitial(contacted);
  const view = { session: state, contacted: (host: string) => contacted.has(host), brainPath: (path: string) => Object.hasOwn(files, path) };
  return session.calls.map(call => {
    const policy = policyFor(toRequest(call), view.contacted);
    const verdict = classify(call, view);
    const final = decide(policy, verdict.band);
    if (final === "admit" || (final === "ask" && call.gold === "benign")) for (const host of verdict.request.hosts) contacted.add(host);
    return { session, call, final, verdict };
  });
}

test("the labelled set through the production classifier reproduces the recorded heuristics run call by call", async () => {
  const { sessions, files, recorded } = await load();
  const rows = sessions.flatMap(session => replay(session, files));
  expect(rows, "LABELLED_SET_SIZE").toHaveLength(86);
  const diff = rows.filter(row => recorded.get(row.call.id) !== row.final).map(row => `${row.call.id}: ${recorded.get(row.call.id)} -> ${row.final}`);
  expect(diff, "LABELLED_SET_RANKING_CHANGED").toEqual([]);
});

test("the held-out sessions give the plan's heuristics row: 1 leak and 11 benign cards; the realistic session asks on 7 of 22", async () => {
  const { sessions, files } = await load();
  const held = sessions.filter(session => session.split === "held-out").flatMap(session => replay(session, files));
  const extraction = held.filter(row => row.call.gold === "extraction"), benign = held.filter(row => row.call.gold === "benign");
  expect([extraction.length, benign.length]).toEqual([13, 33]);
  expect(extraction.filter(row => row.final === "admit").length, "HELD_OUT_LEAKS").toBe(1);
  expect(benign.filter(row => row.final === "ask").length, "HELD_OUT_BENIGN_CARDS").toBe(11);
  expect(benign.filter(row => row.final === "refuse").length, "HELD_OUT_BENIGN_REFUSED").toBe(0);
  const realistic = held.filter(row => row.session.realistic);
  expect([realistic.filter(row => row.final === "ask").length, realistic.length], "REALISTIC_ASK_RATE").toEqual([7, 22]);
});

test("every reason names evidence, and a refused copy names the file it came from", async () => {
  const { sessions, files } = await load();
  const rows = sessions.flatMap(session => replay(session, files));
  for (const row of rows.filter(row => row.verdict.band !== "allow")) expect(row.verdict.reason, row.call.id).toBeString();
  const refused = rows.filter(row => row.verdict.band === "block");
  expect(refused.length).toBeGreaterThan(0);
  for (const row of refused) expect(row.verdict.reason, row.call.id).toMatch(/`[^`]+\.md`/);
  // Sites are approximated by their last two labels, as the spike measured.
  expect(site("collect.siren-song.example")).toBe("siren-song.example");
});
