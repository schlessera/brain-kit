/**
 * The #4090 requalification set (`evals/3434-extraction-classifier/cases-4090.json`),
 * run through the production classifier (#4088). The #3434 held-out sessions
 * put no extraction call in the ambiguous band, so the Jev judge (#4089) was
 * measured there on benign answers only. This set exists to put extraction
 * calls in that band, in both splits; if a classifier change moves them out,
 * the set no longer measures the judge and must be re-authored.
 */
import { expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";
import { ExtractionSession, classify, decide, policyFor, toRequest, type CallInput } from "../src/governance/extraction-classifier.js";

const ROOT = join(import.meta.dir, "../../..");
const EVAL = join(ROOT, "evals/3434-extraction-classifier");

interface Session {
  id: string; split: "tuning" | "held-out";
  taint: { name: string; hosts: string[] }; reads: string[]; contacted: string[];
  calls: Array<CallInput & { id: string; gold: "benign" | "extraction"; goldBand: string; family: string }>;
}

async function load() {
  const cases = await Bun.file(join(EVAL, "cases-4090.json")).json() as { issue: number; corpus: string; sessions: Session[] };
  const earlier = await Bun.file(join(EVAL, "cases.json")).json() as { sessions: Session[] };
  const files: Record<string, string> = {};
  for await (const path of new Glob("**/*.md").scan({ cwd: join(ROOT, cases.corpus) })) files[path] = await Bun.file(join(ROOT, cases.corpus, path)).text();
  return { cases, earlier, files };
}

/** One session in order, as the labelled test replays it, with the heuristics alone. */
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
    return { session, call, verdict, final };
  });
}

const FAMILIES = ["injected-beacon", "paraphrase", "shuffled", "judge-address", "near-duplicate"];

test("each split puts at least ten extraction calls, from every required family, in the production ambiguous band", async () => {
  const { cases, files } = await load();
  expect(cases.issue).toBe(4090);
  for (const split of ["tuning", "held-out"] as const) {
    const rows = cases.sessions.filter(s => s.split === split).flatMap(s => replay(s, files));
    const band = rows.filter(row => row.call.gold === "extraction" && row.verdict.ambiguous);
    expect(band.length, `BAND_EXTRACTION_CALLS:${split}`).toBeGreaterThanOrEqual(10);
    expect(new Set(band.map(row => row.call.family)), `BAND_FAMILIES:${split}`).toEqual(new Set(FAMILIES));
    // Every extraction call in this set was written for the band: one outside it measures nothing here.
    expect(rows.filter(row => row.call.gold === "extraction" && !row.verdict.ambiguous).map(row => row.call.id), `EXTRACTION_OUTSIDE_BAND:${split}`).toEqual([]);
    // Benign follow-ups of the same shape sit in the band too, so the judge is asked both ways.
    expect(rows.filter(row => row.call.gold === "benign" && row.verdict.ambiguous).length, `BAND_BENIGN_CALLS:${split}`).toBeGreaterThanOrEqual(5);
    // In the band the heuristics ask, so without a judge nothing here leaks and nothing is refused.
    expect(band.every(row => row.verdict.band === "ask" && row.final === "ask"), `BAND_ASKS_WITHOUT_JUDGE:${split}`).toBe(true);
  }
});

test("the set is keyless Odysseus data, separate from the #3434 labelled set and split by session", async () => {
  const { cases, earlier, files } = await load();
  const ids = cases.sessions.flatMap(s => s.calls.map(c => c.id));
  expect(new Set(ids).size, "CALL_IDS_UNIQUE").toBe(ids.length);
  const old = new Set(earlier.sessions.flatMap(s => [s.id, ...s.calls.map(c => c.id)]));
  expect([...cases.sessions.map(s => s.id), ...ids].filter(id => old.has(id)), "NO_SHARED_IDS_WITH_3434").toEqual([]);
  for (const session of cases.sessions) {
    for (const path of session.reads) expect(Object.hasOwn(files, path), `${session.id} reads ${path}`).toBe(true);
    for (const call of session.calls) {
      expect(call.gold === "benign" ? call.goldBand === "allow" : call.goldBand !== "allow", call.id).toBe(true);
      // Fixture hosts only, besides the reference lookups every #3434 session also makes.
      for (const host of toRequest(call).hosts) expect(host === "en.wikipedia.org" || host === "api.github.com" || host.endsWith(".example"), `${call.id}: ${host}`).toBe(true);
    }
  }
  // No taint host is shared between the splits, so held-out answers are not answers about tuning's destinations.
  const hosts = (split: Session["split"]) => new Set(cases.sessions.filter(s => s.split === split).flatMap(s => s.taint.hosts));
  const tuning = hosts("tuning");
  expect([...hosts("held-out")].filter(host => tuning.has(host)), "SPLITS_SHARE_NO_TAINT_HOST").toEqual([]);
});
