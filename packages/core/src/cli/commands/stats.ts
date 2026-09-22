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
import { collectStats, type BrainStats } from "../../lib/stats.js";
import { DEFAULT_STALENESS, DEFAULT_STATS_THRESHOLDS } from "../../lib/config.js";
import type { Taxonomy } from "../../lib/taxonomy.js";
import type { CoreCommand } from "../types.js";
import { emit, openReadonlyDb, parseArgs } from "../io.js";

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
chunks, embeddings, corpus bytes and files on disk (configured excludes apply),
brain.db bytes and row counts, free space on the volume.

A figure that cannot be measured is reported as \`n/a\`, never as 0.

--json: unaffected by --all — it always carries the full, uncapped breakdowns.`;

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
 */
export function staleThresholdsFor(taxonomy: Taxonomy): StaleThresholds {
  return {
    perType: Object.entries(taxonomy.types)
      .filter(([, spec]) => spec.staleDays !== undefined && spec.dir !== null)
      .map(([type, spec]) => ({ type, days: spec.staleDays as number }))
      .sort((a, b) => a.days - b.days || a.type.localeCompare(b.type)),
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

  const broken =
    health.brokenLinkRate === null
      ? `n/a — no links to judge (ceiling ${ceiling})`
      : `${stats.brokenLinks} of ${stats.links} (${pct(health.brokenLinkRate)}), ` +
        `${health.brokenLinkRate > brokenLinkCeiling ? "over" : "within"} the ${ceiling} ceiling`;

  // "not measured", not "nothing embedded": collectStats returns null for a
  // brain that does not embed AND for one whose vec_chunks could not be
  // counted because the extension would not load on this connection — an
  // index that may well hold every vector it should. The renderer cannot tell
  // the two apart, so it must not claim either.
  const coverage =
    health.embeddingCoverage === null
      ? `n/a — not measured (floor ${floor})`
      : `${pct(health.embeddingCoverage)} of ${plural(stats.chunks, "chunk")}, ` +
        `${health.embeddingCoverage < coverageFloor ? "below" : "meets"} the ${floor} floor`;

  // "(180)" when no type carries its own window — "(else 180)" would name an
  // exception list that is empty.
  const windows =
    stale.perType.length === 0
      ? `${stale.defaultDays}`
      : [...stale.perType.map((w) => `${w.type} ${w.days}`), `else ${stale.defaultDays}`].join(", ");

  return [
    "Health",
    "",
    healthLine("Broken links", broken),
    healthLine("Embedding coverage", coverage),
    healthLine("Stale", `${health.stale} — past their type's staleDays (${windows})`),
    healthLine("Orphans", `${health.orphans} — no wiki-link in either direction`),
    healthLine("Untagged", `${health.untagged} — no tags (archived excluded)`),
  ];
}

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
  if (stats.embeddings > 0) lines.push(`  Embeddings: ${stats.embeddings}`);
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
  if (stats.documents === 0) {
    return "Brain Statistics\n\n  No documents indexed. Add markdown under the brain root, then run `brain index`.";
  }

  return [
    "Brain Statistics",
    "",
    ...healthSection(stats, opts.stale),
    "",
    ...inventorySection(stats, opts.all),
  ].join("\n");
}

export const statsCommand: CoreCommand = {
  summary: "Show corpus statistics",
  helpBlock: HELP,
  async run(args, cli) {
    const { flags } = parseArgs(args);
    const db = openReadonlyDb(cli.brain);
    try {
      const stats = await collectStats(db, {
        root: cli.brain.root,
        dbPath: cli.brain.dbPath,
        taxonomy: cli.brain.taxonomy,
        config: cli.brain.config,
        embeddingsConfigured: cli.embeddings !== undefined || cli.brain.config?.embeddings !== undefined,
      });

      emit(cli.json, stats, () => {
        console.log(
          formatStats(stats, { all: flags.all === true, stale: staleThresholdsFor(cli.brain.taxonomy) })
        );
      });
    } finally {
      db.close();
    }
  },
};
