import type { BarListRow, ReceiptRow, StatTile, Tone } from "@schlessera/brain-ui-kit";
import type { ActivityRuntimeStats } from "@schlessera/brain-ui-sdk/protocol";
import type { CorpusStats } from "../../../lib/api-client.js";

/**
 * The /stats answer as data (#97): the two channels in, the kit blocks out,
 * every figure already a string. The design is on the issue (its 2026-09-24
 * comment as amended in the body, and #174 for the narrow layout).
 *
 * The two channels count different things and never sum: the corpus is
 * `brain stats --json`, the runtime is the server's own database. So they
 * stay visually apart, and each can fail without taking the other down.
 *
 * Nothing is computed here that the server did not compute. The only
 * arithmetic is formatting, and a bar's length, which is a count's share of
 * the document total. An average the server withheld as `null` stays
 * withheld: dividing a sum here would put back the fabricated rate the
 * `null` exists to refuse.
 */

/** A channel's answer, or why there is none. */
export type Fetched<T> = { ok: true; value: T } | { ok: false; error: string };

export type StatsSection =
  | { kind: "callout"; tone: Tone; variant: "boxed" | "plain"; title: string; body: string }
  | { kind: "tiles"; source: "corpus" | "runtime"; tiles: StatTile[] }
  | { kind: "bars"; title: string; meta: string; rows: BarListRow[] }
  | {
      kind: "receipt";
      title: string;
      rows: ReceiptRow[];
      footnote?: string;
      footTone?: Tone;
    };

/**
 * The receipt key column. Wide enough for the longest key (`tokens out`,
 * `per session`), which at the kit default of 56 would run into its value
 * (#88).
 */
export const RECEIPT_KEY_WIDTH = 78;

/**
 * Characters a receipt value may take at 320px with `RECEIPT_KEY_WIDTH`:
 * 24 on a plain row and 21 on a toned one, whose cue glyph takes three
 * (measured at the default key width in
 * `packages/ui-kit/tests/visual/receipt-value-budget.visual.tsx`: 28 and 25,
 * less the 22px this column adds). One figure per row keeps every value
 * inside it, so no number ever breaks across lines.
 */
export const VALUE_BUDGET = { plain: 24, toned: 21 } as const;

/** How many rows a breakdown shows before the rest fold into one. */
export const BAR_CAP = 6;

export interface StatsInput {
  corpus: Fetched<CorpusStats>;
  runtime: Fetched<ActivityRuntimeStats>;
}

export function composeStatsAnswer({ corpus, runtime }: StatsInput): StatsSection[] {
  const c = corpus.ok ? corpus.value : null;
  const r = runtime.ok ? runtime.value : null;
  const out: StatsSection[] = [];

  const rungs = [...(c ? corpusRungs(c) : []), ...(r ? runtimeRungs(r) : [])];
  if (rungs.length > 0) {
    // One notice, the most urgent. The rest keep their tone on the tile or
    // row below, and the notice says how many there are. The count goes in
    // the copy, not in a trailing chip: at 320px a chip beside the text
    // squeezes it into a column a word wide.
    const [top, ...rest] = rungs;
    const more = rest.length ? ` ${rest.length === 1 ? "One more figure is" : `${rest.length} more figures are`} flagged below.` : "";
    out.push({ ...top, body: top.body + more });
  }

  if (!corpus.ok) {
    out.push(unavailable("Corpus", `\`brain stats\` failed: ${corpus.error}.`, "run /stats again for notes and links."));
  } else if (c && c.documents === 0) {
    out.push({
      kind: "callout",
      tone: "teal",
      variant: "boxed",
      title: "This brain has no notes yet.",
      body: "Add one with /add, and its figures appear here.",
    });
  } else if (c) {
    out.push({ kind: "tiles", source: "corpus", tiles: corpusTiles(c) });
  }

  if (!runtime.ok) {
    out.push(unavailable("Runtime", `The server did not answer: ${runtime.error}.`, "run /stats again for runs and cost."));
  } else if (r && neverRan(r)) {
    out.push({
      kind: "callout",
      tone: "neutral",
      variant: "plain",
      title: "No agent runs recorded yet.",
      body: "Runs and cost appear here after the first chat turn finishes.",
    });
  } else if (r) {
    out.push({ kind: "tiles", source: "runtime", tiles: runtimeTiles(r) });
  }

  if (c && c.documents > 0) {
    out.push(breakdown("Documents by type", c.byType, c.documents, ["type", "types"]));
    if (Object.keys(c.byStatus).length) out.push(breakdown("By status", c.byStatus, c.documents, ["status", "statuses"]));
    if (Object.keys(c.byRelevance).length) {
      out.push(breakdown("By relevance", c.byRelevance, c.documents, ["level", "levels"]));
    }
    out.push(corpusReceipt(c));
  }

  if (r && !neverRan(r)) {
    if (r.window.runs > 0) out.push(windowReceipt(r));
    out.push(lifetimeReceipt(r));
  }

  if (c || r) out.push(diskReceipt(c, r, runtime.ok));
  return out;
}

/* ── Health: the callout ladder ─────────────────────────────────────────── */

type Rung = Extract<StatsSection, { kind: "callout" }>;

/**
 * Every rung that fires, most urgent first. Only one is drawn; the others
 * are counted on its chip and stay visible as their toned tile or row.
 * Stale, orphan and untagged counts have no threshold, so they never fire.
 * The verdicts compare the unrounded values; only the display rounds.
 */
function corpusRungs(c: CorpusStats): Rung[] {
  const out: Rung[] = [];
  const { embeddingCoverage: coverage, brokenLinkRate: rate, thresholds } = c.health;
  if (coverage !== null && coverage < thresholds.coverageFloor) {
    const shown = judgedPair(coverage, thresholds.coverageFloor);
    out.push({
      kind: "callout",
      tone: "red",
      variant: "boxed",
      title: `Only ${shown.ratio} of ${count(c.chunks)} chunks have a vector, under the ${shown.threshold} floor.`,
      body: "Meaning-based search cannot reach the text in the rest. Run `brain index --embeddings`.",
    });
  }
  if (rate !== null && rate > thresholds.brokenLinkCeiling) {
    const shown = judgedPair(rate, thresholds.brokenLinkCeiling);
    out.push({
      kind: "callout",
      tone: "gold",
      variant: "boxed",
      title: `${plural(c.brokenLinks, "link points", "links point")} at notes that don't exist.`,
      body: `That is ${shown.ratio} of all links, over the ${shown.threshold} ceiling. \`brain validate\` lists each one with the file it is in.`,
    });
  }
  return out;
}

function runtimeRungs(r: ActivityRuntimeStats): Rung[] {
  const w = r.window;
  if (w.failures === 0) return [];
  return [
    {
      kind: "callout",
      tone: "gold",
      variant: "boxed",
      title: `${plural(w.failures, "agent run", "agent runs")} failed in the last ${plural(windowDays(r), "day", "days")}.`,
      body: `That is ${count(w.failures)} of ${count(w.runs)}. The Activity view shows what each one was doing when it stopped.`,
    },
  ];
}

function unavailable(half: string, why: string, next: string): StatsSection {
  return {
    kind: "callout",
    tone: "neutral",
    variant: "boxed",
    title: `${half} figures unavailable.`,
    body: `${why} The figures below are current; ${next}`,
  };
}

/* ── Tiles: the answer at a glance, one row per source ──────────────────── */

function corpusTiles(c: CorpusStats): StatTile[] {
  const { brokenLinkRate: rate, thresholds } = c.health;
  const over = rate !== null && rate > thresholds.brokenLinkCeiling;
  const shown = rate === null ? null : judgedPair(rate, thresholds.brokenLinkCeiling);
  return [
    {
      label: "documents",
      value: count(c.documents),
      meta: `${plural(Object.keys(c.byType).length, "type", "types")} · ${plural(c.tags, "tag", "tags")}`,
    },
    {
      label: "broken links",
      value: count(c.brokenLinks),
      meta: shown ? `${shown.ratio} of ${count(c.links)} · ceiling ${shown.threshold}` : "no links to judge",
      ...(over ? { tone: "gold" as const } : {}),
    },
  ];
}

function runtimeTiles(r: ActivityRuntimeStats): StatTile[] {
  const w = r.window;
  const span = `· ${windowDays(r)}d`;
  if (w.runs === 0) {
    return [
      { label: `runs ${span}`, value: "0", meta: w.recordedSince === null ? "none on record" : "none in this window" },
      { label: `spent ${span}`, value: "—", meta: "no runs in this window", tone: "dim" },
    ];
  }
  const paid = cost(w.effectiveCostUsd, w.unpricedRuns, w.runs);
  const list = cost(w.costUsd, w.unpricedListCostRuns, w.runs);
  return [
    {
      label: `runs ${span}`,
      value: count(w.runs),
      meta: w.failures ? `${count(w.failures)} failed` : "none failed",
    },
    {
      label: `spent ${span}`,
      value: paid,
      meta: w.unpricedRuns ? `${count(w.unpricedRuns)} of ${count(w.runs)} unpriced` : `list price ${list}`,
      ...(w.unpricedRuns === w.runs ? { tone: "dim" as const } : {}),
    },
  ];
}

/* ── Breakdowns ─────────────────────────────────────────────────────────── */

/**
 * One breakdown as bars, ranked by count. Past `BAR_CAP` rows the tail folds
 * into one `N other <noun>s` row carrying its summed count, so the bars still
 * add up to what they break down; `brain stats --all` lists the tail.
 * A bar's length is the count's share of all documents, so bars of
 * different breakdowns read on one scale.
 */
function breakdown(
  title: string,
  counts: Record<string, number>,
  documents: number,
  [one, many]: [string, string]
): StatsSection {
  const ranked = Object.entries(counts).sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0));
  const shown = ranked.length > BAR_CAP ? ranked.slice(0, BAR_CAP - 1) : ranked;
  const rest = ranked.slice(shown.length);
  const share = (n: number) => (documents > 0 ? (n / documents) * 100 : 0);
  const rows: BarListRow[] = shown.map(([label, n]) => ({ label, pct: share(n), value: count(n), tone: "teal" }));
  if (rest.length) {
    const n = rest.reduce((sum, [, v]) => sum + v, 0);
    rows.push({
      label: `${count(rest.length)} other ${many}`,
      pct: share(n),
      value: count(n),
      tone: "neutral",
    });
  }
  return { kind: "bars", title, meta: plural(ranked.length, one, many), rows };
}

/* ── Receipts: everything else, one figure per row ──────────────────────── */

function corpusReceipt(c: CorpusStats): StatsSection {
  const { brokenLinkRate: rate, embeddingCoverage: coverage, thresholds } = c.health;
  const brokenOver = rate !== null && rate > thresholds.brokenLinkCeiling;
  const coverageUnder = coverage !== null && coverage < thresholds.coverageFloor;
  const rows: ReceiptRow[] = [
    { k: "tags", v: count(c.tags) },
    { k: "links", v: count(c.links) },
    {
      k: "broken",
      v: rate === null ? count(c.brokenLinks) : `${count(c.brokenLinks)} · ${judgedPair(rate, thresholds.brokenLinkCeiling).ratio}`,
      ...(brokenOver ? { tone: "gold" as const } : {}),
    },
    { k: "chunks", v: count(c.chunks) },
    { k: "embeddings", v: c.embeddings === null ? "not counted" : count(c.embeddings) },
    {
      k: "coverage",
      // Null is not "not configured": it is also a brain with no chunks, or
      // a vector count that failed. It is only ever "not measured".
      v: coverage === null ? "not measured" : judgedPair(coverage, thresholds.coverageFloor).ratio,
      ...(coverageUnder ? { tone: "red" as const } : coverage === null ? { tone: "dim" as const } : {}),
    },
    { k: "stale", v: count(c.health.stale) },
    { k: "orphans", v: count(c.health.orphans) },
    { k: "untagged", v: count(c.health.untagged) },
  ];
  return { kind: "receipt", title: "Corpus", rows };
}

function windowReceipt(r: ActivityRuntimeStats): StatsSection {
  const w = r.window;
  const from = w.recordedSince !== null && w.recordedSince > w.since ? w.recordedSince : w.since;
  const rows: ReceiptRow[] = [];
  if (w.coveredDays < w.days) {
    rows.push({ k: "covers", v: `${count(w.coveredDays)} of ${plural(w.days, "day", "days")}` });
  }
  rows.push(
    { k: "runs", v: count(w.runs) },
    { k: "failed", v: count(w.failures), ...(w.failures ? { tone: "gold" as const } : {}) },
    { k: "paid", v: cost(w.effectiveCostUsd, w.unpricedRuns, w.runs), ...unknownTone(w.unpricedRuns, w.runs) },
    { k: "list price", v: cost(w.costUsd, w.unpricedListCostRuns, w.runs), ...unknownTone(w.unpricedListCostRuns, w.runs) },
  );
  // Two counters, because the two columns are independently unknown: a
  // subscription run's paid cost is a known $0 while its list price is not.
  if (w.unpricedRuns || w.unpricedListCostRuns) {
    rows.push({ k: "unpriced", v: `${count(w.unpricedRuns)} paid · ${count(w.unpricedListCostRuns)} list` });
  }
  rows.push(
    {
      k: "per month",
      v: w.averages.effectiveCostUsdPerMonth === null ? "not computed" : usd(w.averages.effectiveCostUsdPerMonth),
      ...(w.averages.effectiveCostUsdPerMonth === null ? { tone: "dim" as const } : {}),
    },
    { k: "tokens in", v: tokens(w.inputTokens) },
    { k: "tokens out", v: tokens(w.outputTokens) },
    { k: "cache read", v: tokens(w.cacheReadTokens) },
    { k: "cache write", v: tokens(w.cacheCreationTokens) },
    {
      k: "runs / day",
      v: w.averages.runsPerDay === null ? "not computed" : w.averages.runsPerDay.toFixed(1),
    },
  );
  // Retention limits the drill-in detail, never the sums: rollups outlive
  // pruning. So it is said once, here, and not on every row.
  const retention = w.detailRetention;
  return {
    kind: "receipt",
    title: `Runtime · ${day(from)} – ${day(w.until)}`,
    rows,
    footnote: retention.insideWindow
      ? `per-run detail is kept ${plural(retention.days, "day", "days")} · ${count(w.detailPrunedRuns)} of these ${plural(w.runs, "run is", "runs are")} totals only`
      : "per-run detail is kept for the whole window",
    footTone: retention.insideWindow ? "gold" : "teal",
  };
}

function lifetimeReceipt(r: ActivityRuntimeStats): StatsSection {
  const l = r.lifetime;
  const avg = l.averages;
  const floor = (value: number | null) => (value === null ? "not computed" : atLeast(value));
  const rows: ReceiptRow[] = [
    { k: "sessions", v: count(l.sessions) },
    { k: "turns", v: count(l.turns) },
    { k: "cost", v: atLeast(l.costUsd) },
    { k: "per session", v: floor(avg.costUsdPerSession) },
    { k: "per month", v: floor(avg.costUsdPerMonth) },
    { k: "avg turns", v: avg.turnsPerSession === null ? "not computed" : avg.turnsPerSession.toFixed(1) },
  ];
  if (l.lastActivityAt !== null) rows.push({ k: "last active", v: day(l.lastActivityAt, true) });
  return {
    kind: "receipt",
    title: l.firstActivityAt === null ? "Since the first session" : `Since ${day(l.firstActivityAt, true)}`,
    rows,
    footnote: "session catalog · an unreported cost was stored as $0, so every cost here is a floor",
    footTone: "neutral",
  };
}

function diskReceipt(c: CorpusStats | null, r: ActivityRuntimeStats | null, runtimeOk: boolean): StatsSection {
  const rows: ReceiptRow[] = [];
  if (c) {
    const corpus = c.size.corpus;
    rows.push(
      { k: "notes", v: corpus ? `${plural(corpus.files, "file", "files")} · ${bytes(corpus.bytes)}` : "not readable" },
      { k: "index", v: c.size.db.bytes === null ? "not measured" : bytes(c.size.db.bytes) },
    );
  }
  rows.push({ k: "server db", v: r ? bytes(r.database.sizeBytes) : runtimeOk ? "not measured" : "unavailable" });
  if (c) rows.push({ k: "free", v: c.size.freeBytes === null ? "not measured" : bytes(c.size.freeBytes) });
  return {
    kind: "receipt",
    title: "On disk",
    rows,
    // Only the index rebuilds from the notes. The server db holds sessions
    // and runs, which exist nowhere else.
    ...(c ? { footnote: "markdown is the source · the search index is rebuildable", footTone: "teal" as const } : {}),
  };
}

/* ── Formatting ─────────────────────────────────────────────────────────── */

const NUMBER = new Intl.NumberFormat("en-US");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function count(n: number): string {
  return NUMBER.format(n);
}

function plural(n: number, one: string, many: string): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}

/** The window's length as the tile says it: the days it actually covers. */
function windowDays(r: ActivityRuntimeStats): number {
  const w = r.window;
  return w.coveredDays > 0 && w.coveredDays < w.days ? w.coveredDays : w.days;
}

function neverRan(r: ActivityRuntimeStats): boolean {
  return r.window.recordedSince === null && r.lifetime.sessions === 0;
}

/**
 * Dollars at cents, rounded here and nowhere else, identically for both
 * channels. A real cost under a cent reads `< $0.01`, never `$0.00`, which
 * would say free.
 */
export function usd(value: number): string {
  if (value > 0 && value < 0.005) return "< $0.01";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * A windowed sum with its unpriced counter: exact when every run is priced,
 * a floor when some are not, and unknown — never `$0` — when none is.
 */
export function cost(sum: number, unpriced: number, runs: number): string {
  if (runs > 0 && unpriced >= runs) return "unknown";
  return unpriced > 0 ? atLeast(sum) : usd(sum);
}

/**
 * A floor. A known part under a cent is still more than nothing, so it
 * reads `> $0.00` rather than a `≥` in front of `< $0.01`.
 */
function atLeast(value: number): string {
  return value > 0 && value < 0.005 ? "> $0.00" : `≥ ${usd(value)}`;
}

function unknownTone(unpriced: number, runs: number): { tone?: "dim" } {
  return runs > 0 && unpriced >= runs ? { tone: "dim" } : {};
}

/** A token count to three significant figures: `1.84 M`, `212 k`, `6.1 M`. */
export function tokens(n: number): string {
  const scale = (value: number, unit: string) => `${Number(value.toPrecision(3))} ${unit}`;
  if (n >= 1_000_000_000) return scale(n / 1_000_000_000, "B");
  if (n >= 1_000_000) return scale(n / 1_000_000, "M");
  if (n >= 1_000) return scale(n / 1_000, "k");
  return count(n);
}

/** The CLI's byte scale (`packages/core/src/cli/commands/stats.ts`, `bytes`). */
export function bytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** `23 Aug`, or `23 Aug 2026` with the year. UTC, so a test pins it. */
function day(ms: number, year = false): string {
  const d = new Date(ms);
  const base = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return year ? `${base} ${d.getUTCFullYear()}` : base;
}

/**
 * A ratio and the threshold that judged it, at one decimal, or at as many as
 * it takes for the two to read as different numbers when they are — so a
 * verdict never looks self-contradictory (`5.0%` over a `5.0%` ceiling). The
 * CLI's `judgedPair` in `packages/core/src/cli/commands/stats.ts` does the
 * same; display only, the verdict is decided on the raw values.
 */
export function judgedPair(ratio: number, threshold: number): { ratio: string; threshold: string } {
  const at = (d: number) => ({ ratio: `${(ratio * 100).toFixed(d)}%`, threshold: `${(threshold * 100).toFixed(d)}%` });
  if (ratio === threshold) return at(1);
  for (let d = 1; d <= 6; d++) {
    const shown = at(d);
    if (shown.ratio !== shown.threshold) return shown;
  }
  // Closer than six places: say which side it is on rather than print two
  // equal numbers under a verdict that tells them apart.
  const shown = at(1);
  return { ratio: `${ratio > threshold ? "just over" : "just under"} ${shown.threshold}`, threshold: shown.threshold };
}
