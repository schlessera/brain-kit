/**
 * `brain stats` — the command, and the human rendering of what
 * `collectStats` measured.
 *
 * The output is layered: a health section (what needs attention, with the
 * levels that judged it) above an inventory section (what is in there, and
 * what it weighs). Breakdowns are ranked by count and capped, because a
 * corpus with forty types used to print forty lines three times over and bury
 * the rows that matter; `--all` prints every row for inspection.
 *
 * `--all` is a human-output flag only. `--json` carries the full, uncapped
 * breakdowns in both modes, so `stats --json` and `stats --all --json` are
 * byte-identical.
 */
import { collectStats, resolveStatsThresholds, type BrainStats } from "../../lib/stats.js";
import { evaluateStatsTrends, readStatsTrends, type StatsTrends } from "../../lib/stats-trends.js";
import {
  DAILY_DAYS,
  historySeries,
  isIsoDate,
  readHistory,
  recordSnapshot,
  snapshotOf,
  STATS_HISTORY_FILE,
  type RecordResult,
  type StatsHistory,
} from "../../lib/stats-history.js";
import { DEFAULT_STALENESS, DEFAULT_STATS_THRESHOLDS } from "../../lib/config.js";
import type { Taxonomy } from "../../lib/taxonomy.js";
import { packageVersion } from "../../package-version.js";
import type { CliContext, CoreCommand } from "../types.js";
import { emit, openReadonlyDb, parseArgs, UsageError } from "../io.js";

/** Ranked rows shown per breakdown before the `+N more` remainder. */
export const BREAKDOWN_CAP = 5;

/** Width the health labels are padded to, so their values line up. */
const LABEL_WIDTH = "Embedding coverage:".length + 1;

const HELP = `brain stats — corpus statistics and health figures

  --all                   Print every row of every breakdown (default: the top
                          ${BREAKDOWN_CAP} by count, then a \`+N more\` remainder line)

Health, printed first: broken-link rate, embedding coverage, stale / orphan /
untagged documents. Its warn levels come from the \`stats\` config block,
defaulting to coverageFloor ${DEFAULT_STATS_THRESHOLDS.coverageFloor}, brokenLinkCeiling ${DEFAULT_STATS_THRESHOLDS.brokenLinkCeiling}, and each health line names
the level it applied. Staleness has no level of its own — it is the taxonomy's
per-type \`staleDays\` (default ${DEFAULT_STALENESS.days}), the window \`brain audit\` already uses, and
the stale line names the windows in force. Orphan means what \`brain audit\`
means, honouring orphanExempt.

Inventory, printed second: documents (by type/status/relevance), tags, links,
chunks, corpus bytes and files on disk (configured excludes apply), brain.db
bytes and row counts, free space on the volume. An \`Embeddings\` row appears
when vectors were counted, and reads \`n/a\` when the brain has a vector table
this host could not read (sqlite-vec did not load).

A figure that cannot be measured is reported as \`n/a\` (\`null\` in --json),
never as 0, and carries no verdict.

Recorded trends compare two non-overlapping seven-day UTC windows ending
today, with at least three valid daily observations each and a recording no
older than 48 hours. Core reports comparison evidence and explicit insufficient,
stale or incomparable states; missing history is never a healthy trend. The
initial warning rules are uncalibrated. See docs/cli.md for the rules.

--json: unaffected by --all — it always carries the full, uncapped breakdowns.

  --record                Also keep today's figures in ${STATS_HISTORY_FILE} at
                          the brain root (one snapshot per UTC day; a second
                          run the same day replaces it). \`brain maintain\`
                          records one on every run.
  --history               Print the recorded snapshots instead, oldest first.
                          --json gives one array per field, ready to chart.
  --since <YYYY-MM-DD>    With --history: only snapshots from that day on.

The history keeps every day for the last ${DAILY_DAYS} days, then one snapshot per week.
It is committed with the brain; \`brain index --force\` never touches it.`;

/** The staleness windows in force, as the stale health line names them. */
export interface StaleThresholds {
  /** Types carrying their own `staleDays`, shortest window first. */
  perType: { type: string; days: number }[];
  /** The window every other type falls back to. */
  defaultDays: number;
}

/**
 * Read the staleness windows off the taxonomy rather than off `--json`: they
 * are not a figure `collectStats` returns, and `brain stats` must not invent a
 * second stale threshold. The `dir !== null` filter mirrors the one
 * `Taxonomy` applies when it builds its own rules — a `staleDays` on a type
 * with no directory never matches a path, so naming it here would describe a
 * window nothing is judged against.
 *
 * Types sharing a window break the tie by name, by code unit for the same
 * reason `breakdown()` does: `localeCompare` reads the runtime's default
 * locale, which neither CI nor a user's shell pins. Less is at stake here —
 * nothing is capped, so no window can vanish, only the order it is named in —
 * but it is the same defect, and fixing one occurrence of a shape is not
 * fixing the shape.
 */
export function staleThresholdsFor(taxonomy: Taxonomy): StaleThresholds {
  return {
    perType: Object.entries(taxonomy.types)
      .filter(([, spec]) => spec.staleDays !== undefined && spec.dir !== null)
      .map(([type, spec]) => ({ type, days: spec.staleDays as number }))
      .sort((a, b) => a.days - b.days || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0)),
    defaultDays: taxonomy.defaultStaleness.days,
  };
}

export interface StatsRenderOptions {
  /** `--all`: every row of every breakdown, and no `+N more` line. */
  all: boolean;
  stale: StaleThresholds;
}

function pct(ratio: number | null): string {
  return ratio === null ? "n/a" : `${(ratio * 100).toFixed(1)}%`;
}

/**
 * The exact decimal expansion of a finite, non-negative double, as a
 * percentage: every digit of `x * 100` without the rounding that the
 * multiplication or `toFixed` (which stops at 100 places) would apply. A
 * double is `mantissa * 2^exponent`, and for a negative exponent that is
 * `mantissa * 5^-exponent / 10^-exponent`, so the digits are one BigInt
 * product.
 */
function exactPercentDigits(x: number): { whole: string; frac: string } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const mantissa = biased === 0 ? fraction : fraction | (1n << 52n);
  const exponent = biased === 0 ? -1074 : biased - 1075;

  let whole: string;
  let frac: string;
  if (exponent >= 0) {
    whole = (mantissa << BigInt(exponent)).toString();
    frac = "";
  } else {
    const places = -exponent;
    const digits = (mantissa * 5n ** BigInt(places)).toString().padStart(places + 1, "0");
    whole = digits.slice(0, -places);
    frac = digits.slice(-places);
  }
  // Two places right for the percentage.
  const shifted = frac.padEnd(2, "0");
  return {
    whole: `${whole}${shifted.slice(0, 2)}`.replace(/^0+(?=\d)/, ""),
    frac: shifted.slice(2).replace(/0+$/, ""),
  };
}

/**
 * The pair as exact digits, cut at the first decimal place where they
 * differ. Truncating is monotone, and the first differing digit keeps the two
 * apart in the right order, for any two distinct doubles — subnormals
 * included — at the cost of a long line in a case only a pathological
 * threshold reaches.
 */
function exactPair(ratio: number, threshold: number): { ratio: string; threshold: string } {
  const r = exactPercentDigits(ratio);
  const t = exactPercentDigits(threshold);
  const width = Math.max(r.frac.length, t.frac.length);
  const rf = r.frac.padEnd(width, "0");
  const tf = t.frac.padEnd(width, "0");
  let decimals = 1;
  if (r.whole === t.whole) {
    let i = 0;
    while (i < width && rf[i] === tf[i]) i++;
    decimals = Math.max(1, i + 1);
  }
  const cut = (whole: string, frac: string) => `${whole}.${frac.padEnd(decimals, "0").slice(0, decimals)}%`;
  return { ratio: cut(r.whole, rf), threshold: cut(t.whole, tf) };
}

/** How far the everyday `pct` formula is widened before giving up on it. */
const MAX_PCT_DECIMALS = 20;

/**
 * A measured ratio and the threshold that judged it, printed at one decimal —
 * or at as many as it takes for the two to read as different numbers when
 * they are. Without the extra places, 6 broken links in 119 printed as `5.0%,
 * over the 5.0% ceiling`: a correct verdict that looked self-contradictory.
 * Both figures widen together, so a threshold configured finer than one
 * decimal is never shown rounded past the ratio it judged. A ratio equal to
 * its threshold, or nowhere near it, prints exactly as `pct` would.
 *
 * The `pct` formula is widened first, so every ordinary line keeps its old
 * rounding. When twenty places of it still collide — `ratio * 100` rounded the
 * two onto one double, or they differ further out than that — the pair is
 * printed from its exact digits instead (`exactPair`).
 *
 * Display only. The verdict is decided on the unrounded values by the caller;
 * comparing at display precision instead would report a corpus over its
 * ceiling as within it, which is a threshold loosened by a formatting choice.
 */
function judgedPair(ratio: number, threshold: number): { ratio: string; threshold: string } {
  const everyday = (decimals: number) => ({
    ratio: `${(ratio * 100).toFixed(decimals)}%`,
    threshold: `${(threshold * 100).toFixed(decimals)}%`,
  });
  if (ratio === threshold) return everyday(1);
  for (let decimals = 1; decimals <= MAX_PCT_DECIMALS; decimals++) {
    const shown = everyday(decimals);
    if (shown.ratio !== shown.threshold) return shown;
  }
  return exactPair(ratio, threshold);
}

/**
 * A byte count at a scale a human reads. The flat-MB rendering this replaces
 * printed a 22 KB corpus as `0.0 MB` and free space as `605726.6 MB` — one
 * reads as nothing and the other cannot be taken in at a glance.
 */
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

function bytes(count: number | null): string {
  if (count === null) return "n/a";
  let value = count;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Whole bytes have nothing to round; every scaled unit keeps one decimal.
  return `${unit === 0 ? value : value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function healthLine(label: string, value: string): string {
  return `  ${`${label}:`.padEnd(LABEL_WIDTH)}${value}`;
}

/**
 * One breakdown, ranked by count and capped unless `--all`.
 *
 * The rows are re-sorted here even though the SQL already ordered them:
 * `collectStats` hands them over as an object, and JavaScript reorders
 * integer-like keys of an object ahead of the rest — a status or type whose
 * name is all digits would otherwise jump the ranking and make the cap keep
 * the wrong five.
 *
 * Ties break by name, compared by code unit rather than `localeCompare`: the
 * cap makes the tie-break decide which rows are printed at all, and
 * `localeCompare` reads the runtime's default locale, which neither CI nor a
 * user's shell pins. Byte order is the same answer everywhere.
 */
function breakdown(label: string, counts: Record<string, number>, all: boolean): string[] {
  const rows = Object.entries(counts).sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
  );
  if (rows.length === 0) return [`  ${label}: none`];

  const lines = [`  ${label}:`];
  const shown = all ? rows : rows.slice(0, BREAKDOWN_CAP);
  for (const [name, count] of shown) lines.push(`    ${name}: ${count}`);

  const rest = rows.slice(shown.length);
  if (rest.length > 0) {
    const total = rest.reduce((sum, [, count]) => sum + count, 0);
    lines.push(`    +${rest.length} more (${plural(total, "document")})`);
  }
  return lines;
}

/**
 * Render the health section. Every null figure says `n/a` and carries no
 * verdict: unknown must never read as a number, and a coverage nobody could
 * measure must never read as a passing one.
 */
function healthSection(stats: BrainStats, stale: StaleThresholds): string[] {
  const { health } = stats;
  const { coverageFloor, brokenLinkCeiling } = health.thresholds;
  const ceiling = pct(brokenLinkCeiling);
  const floor = pct(coverageFloor);

  let broken = `n/a — no links to judge (ceiling ${ceiling})`;
  if (health.brokenLinkRate !== null) {
    const shown = judgedPair(health.brokenLinkRate, brokenLinkCeiling);
    broken =
      `${stats.brokenLinks} of ${stats.links} (${shown.ratio}), ` +
      `${health.brokenLinkRate > brokenLinkCeiling ? "over" : "within"} the ${shown.threshold} ceiling`;
  }

  // "not measured", not "nothing embedded": collectStats returns null for a
  // brain that does not embed AND for one whose vec_chunks could not be
  // counted because the extension would not load on this connection — an
  // index that may well hold every vector it should. The renderer cannot tell
  // the two apart, so it must not claim either.
  let coverage = `n/a — not measured (floor ${floor})`;
  if (health.embeddingCoverage !== null) {
    const shown = judgedPair(health.embeddingCoverage, coverageFloor);
    coverage =
      `${shown.ratio} of eligible chunks, ` +
      `${health.embeddingCoverage < coverageFloor ? "below" : "meets"} the ${shown.threshold} floor`;
  }

  // "(180)" when no type carries its own window — "(else 180)" would name an
  // exception list that is empty.
  const windows =
    stale.perType.length === 0
      ? `${stale.defaultDays}`
      : [...stale.perType.map((w) => `${w.type} ${w.days}`), `else ${stale.defaultDays}`].join(", ");

  return [
    "Health",
    "",
    healthLine("Broken links", broken + trendEvidence(stats, "brokenLinks")),
    healthLine("Embedding coverage", coverage + trendEvidence(stats, "embeddingCoverage")),
    healthLine("Stale", `${health.stale} — past their type's staleDays (${windows})`),
    healthLine("Orphans", `${health.orphans} — no wiki-link in either direction` + trendEvidence(stats, "orphans")),
    healthLine("Untagged", `${health.untagged} — no tags (archived excluded)`),
  ];
}

function trendEvidence(stats: BrainStats, metric: string): string {
  const v = stats.trends?.verdicts.find(v => v.metric === metric);
  return v ? `\n    Trend: ${v.message}` : "";
}

/** The inventory row for a vector table this host could not count. */
const UNKNOWN_EMBEDDINGS = "  Embeddings: n/a — vector table could not be read on this host";

function inventorySection(stats: BrainStats, all: boolean): string[] {
  const { size } = stats;
  const lines = [
    "Inventory",
    "",
    `  Documents: ${stats.documents}`,
    ...breakdown("By type", stats.byType, all),
    ...breakdown("By status", stats.byStatus, all),
    ...breakdown("By relevance", stats.byRelevance, all),
    `  Tags: ${stats.tags}`,
    `  Links: ${stats.links} (${stats.brokenLinks} broken)`,
    `  Chunks: ${stats.chunks}`,
  ];
  // Suppressed at 0 (nothing embedded is not worth a row), but never when the
  // count is unknown: a brain whose vectors could not be read must not render
  // like one holding none.
  if (stats.embeddings === null) lines.push(UNKNOWN_EMBEDDINGS);
  else if (stats.embeddings > 0) lines.push(`  Embeddings: ${stats.embeddings}`);
  lines.push(
    `  Corpus: ${size.corpus ? `${plural(size.corpus.files, "file")}, ${bytes(size.corpus.bytes)}` : "n/a"}`,
    `  Index: ${bytes(size.db.bytes)}`,
    `  Free space: ${bytes(size.freeBytes)}`
  );
  return lines;
}

/** The whole human report, as one string (no trailing newline). */
export function formatStats(stats: BrainStats, opts: StatsRenderOptions): string {
  // Nothing indexed: every ratio is already null and every breakdown empty, so
  // the sections would print a page of `n/a` that tells the user nothing they
  // can act on. One line that names the next step does.
  // An unreadable vector table is still worth its line: it is the one figure
  // here that is unknown rather than empty.
  if (stats.documents === 0) {
    const empty = "Brain Statistics\n\n  No documents indexed. Add markdown under the brain root, then run `brain index`.";
    const warnings = stats.trends?.verdicts.filter(v => v.state === "warning").map(v => `\n  Trend: ${v.message}`).join("") ?? "";
    return (stats.embeddings === null ? `${empty}\n${UNKNOWN_EMBEDDINGS}` : empty) + warnings;
  }

  return [
    "Brain Statistics",
    "",
    ...healthSection(stats, opts.stale),
    "",
    ...inventorySection(stats, opts.all),
  ].join("\n");
}

/** Every figure `brain stats` reports, for this CLI context. */
async function collectFor(cli: CliContext, now = new Date()): Promise<BrainStats> {
  const db = openReadonlyDb(cli.brain);
  try {
    const stats = await collectStats(db, {
      root: cli.brain.root,
      dbPath: cli.brain.dbPath,
      taxonomy: cli.brain.taxonomy,
      config: cli.brain.config,
      embeddingsConfigured: cli.embeddings !== undefined || cli.brain.config?.embeddings !== undefined,
      now,
    });
    stats.trends = readStatsTrends(cli.brain.root, stats.health.thresholds, now);
    return stats;
  } finally {
    db.close();
  }
}

/**
 * Keep `stats` as the day's snapshot. Shared by `brain stats --record` and the
 * `brain maintain` step, so the two cannot record different things.
 */
export function recordStats(cli: CliContext, stats: BrainStats, now = new Date()): RecordResult {
  return recordSnapshot(cli.brain.root, snapshotOf(stats, { now, version: packageVersion() }));
}

/** Collect today's figures and record them: the `brain maintain` step. */
export async function collectAndRecordStats(cli: CliContext, now = new Date()): Promise<RecordResult & { trends: StatsTrends }> {
  const stats = await collectFor(cli, now);
  return { ...recordStats(cli, stats, now), trends: stats.trends! };
}

/** How a recording reads in a report line. */
export function describeRecord(result: RecordResult): string {
  const thinned = result.thinned > 0 ? `, ${result.thinned} older thinned` : "";
  return `${result.replaced ? "replaced" : "recorded"} ${result.date} in ${STATS_HISTORY_FILE} (${plural(result.kept, "snapshot")} kept${thinned})`;
}

function cell(value: number | null, format: (n: number) => string = String): string {
  return value === null ? "n/a" : format(value);
}

/** The human rendering of `--history`: one row per snapshot, oldest first. */
export function formatHistory(history: StatsHistory): string {
  const n = history.dates.length;
  if (n === 0) {
    return (
      "Stats history\n\n  No snapshots recorded yet. `brain maintain` records one a day; " +
      "`brain stats --record` records one now."
    );
  }
  const header = ["date", "documents", "orphans", "stale", "coverage", "broken"];
  const rows = history.dates.map((date, i) => [
    date,
    cell(history.documents[i]),
    cell(history.health.orphans[i]),
    cell(history.health.stale[i]),
    cell(history.health.embeddingCoverage[i], (r) => pct(r)),
    cell(history.health.brokenLinkRate[i], (r) => pct(r)),
  ]);
  const widths = header.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c].length)));
  const line = (r: string[]) =>
    `  ${r.map((v, c) => (c === 0 ? v.padEnd(widths[c]) : v.padStart(widths[c]))).join("  ")}`.trimEnd();
  const span = n === 1 ? history.dates[0] : `${history.dates[0]} – ${history.dates[n - 1]}`;
  return [`Stats history (${plural(n, "snapshot")}, ${span})`, "", line(header), ...rows.map(line),
    ...(history.trends?.verdicts.map(v => `\n  Trend: ${v.message}`) ?? []),
  ].join("\n");
}

export const statsCommand: CoreCommand = {
  summary: "Show corpus statistics",
  helpBlock: HELP,
  async run(args, cli) {
    const { flags } = parseArgs(args);

    if (flags.history === true) {
      if (flags.record === true) throw new UsageError("--history reads the snapshots; it cannot be combined with --record");
      const since = flags.since;
      if (since !== undefined && (typeof since !== "string" || !isIsoDate(since))) {
        throw new UsageError("--since takes a date as YYYY-MM-DD");
      }
      const snapshots = readHistory(cli.brain.root);
      const history = historySeries(snapshots, since as string | undefined);
      history.trends = evaluateStatsTrends(historySeries(snapshots), resolveStatsThresholds(cli.brain.config));
      emit(cli.json, history, () => console.log(formatHistory(history)));
      return;
    }
    if (flags.since !== undefined) throw new UsageError("--since only applies with --history");

    const stats = await collectFor(cli);
    // Recorded before anything is printed, so a failed write fails the
    // command instead of following a report that looked complete.
    const recorded = flags.record === true ? recordStats(cli, stats) : null;

    emit(cli.json, stats, () => {
      console.log(
        formatStats(stats, { all: flags.all === true, stale: staleThresholdsFor(cli.brain.taxonomy) })
      );
      if (recorded) console.log(`\nHistory: ${describeRecord(recorded)}`);
    });
    // stdout stays exactly the stats object under --json; the note goes aside.
    if (recorded && cli.json) console.error(`History: ${describeRecord(recorded)}`);
  },
};
