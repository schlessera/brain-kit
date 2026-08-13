import { runGraphPrecompute } from "../../lib/graph/precompute.js";
import { resolveGraphRoot } from "../../lib/graph/root.js";
import {
  getClusterGraph,
  getDiscoveryGraph,
  getEgoGraph,
  getGraphStats,
  getMaintenanceFindings,
  DEFAULT_STALE_DAYS,
} from "../../lib/graph/queries.js";
import type { GraphDirection } from "../../lib/graph/types.js";
import { openDatabase } from "../../lib/db.js";
import type { CoreCommand, CliContext } from "../types.js";
import { emit, openReadonlyDb, parseArgs, UsageError } from "../io.js";

const HELP = `brain graph <compute|export|stats>

  compute [--root <path>]     Rebuild the derived graph tables from the index
  export --mode <mode> ...    Dump one graph view
  stats                       Node/edge/component counts, communities, root

export modes:
  clusters      Whole vault with communities and precomputed layout
                --community <n>   Restrict to one community
                --no-isolates     Drop notes with no links at all
  local         Neighbourhood around one note
                --center <path>   Required
                --depth <1-3>     Default 1
                --direction <in|out|both>   Default both
  discovery     Rings outward from the root
                --root <path>     Default: the precomputed root
                --direction <in|out|both>   Default out
                --depth <1-8>     Default 8
  maintenance   Orphans, unreachable notes, broken links, stale notes
                --stale-days <n>  Default ${DEFAULT_STALE_DAYS}

--json: the mode's payload. Graph tables are rebuilt by every index run; they
stay empty until the first one on schema v8.`;

const DIRECTIONS = new Set<GraphDirection>(["in", "out", "both"]);

function parseDirection(value: string | boolean | undefined, fallback: GraphDirection): GraphDirection {
  if (value === undefined || value === true) return fallback;
  if (!DIRECTIONS.has(value as GraphDirection)) {
    throw new UsageError(`--direction must be one of in|out|both (got "${value}")`);
  }
  return value as GraphDirection;
}

function parseCount(value: string | boolean | undefined, flag: string): number | undefined {
  if (value === undefined || value === true) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new UsageError(`${flag} must be a non-negative integer (got "${value}")`);
  }
  return parsed;
}

function requireString(value: string | boolean | undefined, flag: string): string {
  if (typeof value !== "string" || !value) throw new UsageError(`${flag} is required`);
  return value;
}

async function computeGraph(args: string[], cli: CliContext): Promise<void> {
  const { flags } = parseArgs(args);
  const rootOverride = typeof flags.root === "string" ? flags.root : undefined;

  const db = openDatabase(cli.brain.dbPath);
  try {
    // An explicit --root that resolves to nothing is a typo, not a corpus
    // without a root — say so instead of silently emptying the distances.
    if (rootOverride) {
      const resolved = resolveGraphRoot(db, {
        root: cli.brain.root,
        taxonomy: cli.brain.taxonomy,
        override: rootOverride,
      });
      if (!resolved) {
        throw new UsageError(
          `--root "${rootOverride}" is neither an indexed document nor a file in the brain repo`
        );
      }
    }

    const result = runGraphPrecompute(db, {
      root: cli.brain.root,
      taxonomy: cli.brain.taxonomy,
      rootOverride,
    });

    emit(cli.json, result, () => {
      console.log("Graph rebuilt\n");
      console.log(`  Nodes: ${result.nodes}`);
      console.log(`  Edges: ${result.edges} (${result.brokenLinks} broken links)`);
      console.log(`  Components: ${result.components}`);
      console.log(`  Communities: ${result.communities}`);
      console.log(`  Root: ${result.root ?? "(none)"}`);
      console.log(`  Reachable from root: ${result.reachable}`);
      if (result.layoutSkipped) console.log("  Layout: skipped (corpus over the layout cap)");
      console.log(`  Took: ${result.durationMs}ms`);
    });
  } finally {
    db.close();
  }
}

async function exportGraph(args: string[], cli: CliContext): Promise<void> {
  const { flags } = parseArgs(args);
  const mode = flags.mode;
  if (typeof mode !== "string") {
    throw new UsageError("Usage: brain graph export --mode <clusters|discovery|local|maintenance>");
  }

  const db = openReadonlyDb(cli.brain);
  try {
    switch (mode) {
      case "clusters": {
        const result = getClusterGraph(db, {
          community: parseCount(flags.community, "--community"),
          includeIsolates: flags["no-isolates"] !== true,
        });
        emit(cli.json, result, () => printSubgraph(result.nodes.length, result.edges.length));
        return;
      }
      case "local": {
        const result = getEgoGraph(db, {
          center: requireString(flags.center, "--center"),
          depth: parseCount(flags.depth, "--depth"),
          direction: parseDirection(flags.direction, "both"),
        });
        emit(cli.json, result, () => printSubgraph(result.nodes.length, result.edges.length));
        return;
      }
      case "discovery": {
        const result = getDiscoveryGraph(db, {
          root: typeof flags.root === "string" ? flags.root : undefined,
          maxDepth: parseCount(flags.depth, "--depth"),
          direction: parseDirection(flags.direction, "out"),
        });
        emit(cli.json, result, () => printSubgraph(result.nodes.length, result.edges.length));
        return;
      }
      case "maintenance": {
        const result = getMaintenanceFindings(db, {
          staleDays: parseCount(flags["stale-days"], "--stale-days"),
        });
        emit(cli.json, result, () => {
          console.log("Graph maintenance\n");
          console.log(`  Root: ${result.root ?? "(none — unreachable check skipped)"}`);
          console.log(`  Orphans: ${result.orphans.length}`);
          console.log(`  Unreachable: ${result.unreachable.length}`);
          console.log(`  Broken links: ${result.brokenLinks.length}`);
          console.log(`  Stale (> ${result.staleDays}d): ${result.stale.length}`);
        });
        return;
      }
      default:
        throw new UsageError(
          `Unknown --mode "${mode}" (expected clusters|discovery|local|maintenance)`
        );
    }
  } finally {
    db.close();
  }
}

function printSubgraph(nodes: number, edges: number): void {
  console.log(`  Nodes: ${nodes}`);
  console.log(`  Edges: ${edges}`);
}

export const graphCommand: CoreCommand = {
  summary: "Inspect and rebuild the derived wiki-link graph",
  helpBlock: HELP,
  async run(args, cli): Promise<number | void> {
    const sub = args[0];
    const rest = args.slice(1);

    if (sub === "compute") return computeGraph(rest, cli);
    if (sub === "export") return exportGraph(rest, cli);

    if (sub === "stats") {
      const db = openReadonlyDb(cli.brain);
      try {
        const stats = getGraphStats(db);
        emit(cli.json, stats, () => {
          console.log("Graph Statistics\n");
          if (!stats.computedAt) {
            console.log("  Not computed yet — run `brain graph compute`.");
            return;
          }
          console.log(`  Computed at: ${stats.computedAt}`);
          console.log(`  Root: ${stats.root ?? "(none)"}`);
          console.log(`  Nodes: ${stats.nodes}`);
          console.log(`  Edges: ${stats.edges} (${stats.brokenLinks} broken)`);
          console.log(`  Components: ${stats.components}`);
          console.log(`  Reachable from root: ${stats.reachable}`);
          if (stats.layoutSkipped) console.log("  Layout: skipped (corpus over the layout cap)");
          console.log(`  Communities: ${stats.communities.length}`);
          for (const community of stats.communities.slice(0, 20)) {
            const label = community.label ?? "(unlabelled)";
            console.log(`    ${community.community}: ${label} — ${community.size} notes`);
          }
        });
      } finally {
        db.close();
      }
      return;
    }

    throw new UsageError("Usage: brain graph <compute|export|stats>");
  },
};
