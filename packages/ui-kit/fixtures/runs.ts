// The agents, their runs, and the receipts for what those runs did.
//
// The agent names are the kit's own functional vocabulary -- researcher,
// note-filer, source-watch, ledger -- and they stay that way. They are the
// modern half of the collision: the tooling is a 2026 second brain, and what
// it is filing is an oath sworn on a beach. Giving the agents mythological
// names would collapse the joke into costume.
//
// Money is stored in whole cents and formatted once, so no fixture prints a
// float it did not mean and no two screens disagree about $0.14.

import { HATCH_GLYPH } from "../src/agents/LaneChart.js";
import type {
  Lane,
  LegendItem,
  OrbitAgent,
  ReceiptRow,
  Run,
  RunId,
  RunTool,
  TraceStep,
} from "./types.js";

export const runs: Run[] = [
  {
    id: "run:4c1",
    agent: "researcher",
    state: "running",
    task: "Compare Circe's sailing directions against the forecast from the house of the dead",
    progress: 72,
    steps: 12,
    tokens: 41_000,
    cents: 14,
    elapsed: "1m 12s",
    thread: "thread:route",
  },
  {
    id: "run:9f2",
    agent: "note-filer",
    state: "waiting",
    task: "File four omens. Two went to omens/; one is about the household and one is about the route",
    progress: 66,
    steps: 7,
    tokens: 9_400,
    cents: 3,
    elapsed: "38s",
    thread: null,
  },
  {
    id: "run:2b8",
    agent: "source-watch",
    state: "failed",
    task: "Check whether the west wind holds for seventeen days",
    progress: 0,
    steps: 3,
    tokens: 1_200,
    cents: 1,
    elapsed: "11s",
    thread: "thread:route",
  },
  {
    id: "run:7e0",
    agent: "ledger",
    state: "done",
    task: "Reconcile the crew ledger against the voyage log, Troy to Ogygia",
    progress: 100,
    steps: 9,
    tokens: 22_000,
    cents: 4,
    elapsed: "2m 05s",
    thread: "thread:crew",
  },
];

export const runById: Record<RunId, Run> = Object.fromEntries(
  runs.map((r) => [r.id, r])
) as Record<RunId, Run>;

/** Total spend across the runs above, in cents. Derived, never restated. */
export const runSpendCents = runs.reduce((sum, r) => sum + r.cents, 0);

/** The one formatter. Everything that prints money goes through it. */
export function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/* ------------------------------------------------------------ kit shapes */

/**
 * The orbit. Distance from the core is proportional to how far from done a
 * run is, and angles are placed rather than animated -- the kit's orbit does
 * not spin, so two fixtures at the same angle overlap forever.
 */
export const orbitAgents: OrbitAgent[] = [
  { name: "researcher", icon: "researcher", tone: "amber", meta: "72%", state: "running", orbit: 0.28, angle: 34 },
  { name: "note-filer", icon: "filer", tone: "teal", meta: "2 of 3", state: "waiting", orbit: 0.34, angle: 126 },
  { name: "source-watch", icon: "watcher", tone: "red", meta: "failed", state: "failed", orbit: 0.92, angle: 214 },
  { name: "ledger", icon: "ledger", tone: "neutral", meta: "done", state: "done", orbit: 0.12, angle: 302 },
];

/** The tool strip on the running run's card. */
export const researcherTools: RunTool[] = [
  { label: "brain_search", state: "done" },
  { label: "Read x3", state: "done" },
  { label: "WebFetch", state: "active" },
  { label: "Edit", state: "idle" },
];

export const watcherTools: RunTool[] = [
  { label: "brain_search", state: "done" },
  { label: "WebFetch", state: "failed" },
];

/**
 * The stalled run's tool timeline. One paused step, which is the whole
 * screen: a run cannot continue until a person answers.
 */
export const researcherTrace: TraceStep[] = [
  {
    state: "done",
    tool: "brain_search",
    text: "sailing directions scylla thrinacia",
    time: "0.4s",
    output: "7 documents, 3 above 0.8",
  },
  {
    state: "done",
    tool: "Read",
    text: "knowledge/teiresias-forecast.md",
    time: "0.1s",
    output: "line 12 contains the only stated condition",
  },
  {
    state: "done",
    tool: "Read",
    text: "people/circe.md",
    time: "0.1s",
    output: "directions given day 611, never contradicted",
  },
  {
    state: "paused",
    tool: "WebFetch",
    text: "winds.example.invalid/seventeen-days",
    time: "waiting",
    output: "outside the envelope -- needs approval",
  },
  { state: "skipped", tool: "Edit", text: "voyage/_index.md", time: "--" },
];

/** The failed run's trace, for the dead-letter story. */
export const watcherTrace: TraceStep[] = [
  { state: "done", tool: "brain_search", text: "wind forecast source", time: "0.3s", output: "1 saved source" },
  {
    state: "failed",
    tool: "WebFetch",
    text: "winds.example.invalid",
    time: "11s",
    output: "NXDOMAIN after 3 attempts · dead-lettered",
  },
];

/** Four lanes on a 0-90s axis. Hatched means waiting on a person. */
export const lanes: Lane[] = [
  { name: "researcher", tone: "amber", segments: [{ start: 0, width: 58 }, { start: 58, width: 20, hatch: true }] },
  { name: "note-filer", tone: "teal", segments: [{ start: 6, width: 30 }, { start: 36, width: 26, hatch: true }] },
  { name: "source-watch", tone: "red", segments: [{ start: 2, width: 12 }] },
  { name: "ledger", tone: "neutral", segments: [{ start: 12, width: 71, fade: true }] },
];

export const laneTicks = ["0s", "30s", "60s", "90s"];

export const laneLegend: LegendItem[] = [
  { label: "running", tone: "amber" },
  // `HATCH_GLYPH`, not the word "hatched". `LaneChart` keys its half-alpha
  // swatch off the glyph STRING, so a legend row spelling it any other way
  // renders the solid swatch and quietly contradicts the chart.
  { label: "waiting on you", tone: "teal", glyph: HATCH_GLYPH },
  { label: "failed", tone: "red" },
];

/**
 * The capability receipt: exactly what a tap would grant, scoped to one file
 * and one run. The footnote is the load-bearing part.
 */
export const fetchReceipt: { rows: ReceiptRow[]; footnote: string } = {
  rows: [
    { k: "tool", v: "WebFetch", tone: "amber" },
    { k: "target", v: "winds.example.invalid/seventeen-days", tone: "purple" },
    { k: "run", v: "run #4c1 · turn 12", tone: "neutral" },
    { k: "writes", v: "voyage/_index.md", tone: "teal" },
    { k: "spend", v: "~$0.02", tone: "neutral" },
  ],
  footnote: "this host only · this run only · not a standing grant",
};

/** The edit the approval would actually make, as a diff. */
export const forecastDiff = "- wind: west, holds 17 days (unverified)\n+ wind: unknown -- source unreachable since day 3,651";

/** What the run is holding while it waits. */
export const blockedQueue: { state: "blocked" | "ready" | "failed"; subject: string; meta: string; link?: string; note?: string }[] = [
  { state: "blocked", subject: "edit · voyage/_index.md", meta: "4m", link: "waiting on this fetch" },
  { state: "ready", subject: "file · omens/day-3651-eagle.md", meta: "9m" },
  {
    state: "failed",
    subject: "fetch · winds.example.invalid",
    meta: "2h",
    note: "dead-lettered after 3 attempts",
  },
];

/**
 * The run-detail header's second line: which run, how far in, what it has cost.
 * Derived from the run itself so it cannot drift from the card beneath it.
 */
export const runDetailMeta = `run #${runs[0]!.id.split(":")[1]} · turn ${runs[0]!.steps} · ~${usd(runs[0]!.cents)}`;

/**
 * The closing banner on the run detail. A stalled run is holding work, and the
 * screen says what it is allowed to do rather than only what it is waiting on.
 */
export const runScopeFootnote = "this run may read the corpus and fetch once · it may not write without you";

/** The footer under the activity screen. */
export const activityFooter = `${runs.length} runs · 74k tok · ${usd(runSpendCents)} spent`;
