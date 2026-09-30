import { loadVecSupport, openDatabase, vecTableExists, migrateVecSchema, storedVectorWidth } from "../../lib/db.js";
import { compactVectors, indexAll, needsCompaction, readVectorSlots } from "../../lib/indexer.js";
import { auditTotals, auditWithModules } from "../../lib/auditor.js";
import { runRegistry } from "../../lib/index-registry.js";
import { pruneScratch } from "../../lib/scratch.js";
import { tagReport } from "../../lib/tags.js";
import { summarizeTagReport } from "./tags.js";
import { collectAndRecordStats, describeRecord } from "./stats.js";
import type { StatsTrends } from "../../lib/stats-trends.js";
import { GitUnavailableError, isGitWorkTree, packRepository } from "../../lib/git-storage.js";
import type { CoreCommand } from "../types.js";
import { emit, embeddingDims, parseArgs, UsageError } from "../io.js";

const HELP = `brain maintain — routine maintenance (cron-friendly)

Runs, in order: the _index.md registry tables (the same step as
\`brain registry\`, which writes only generated regions whose table changed),
an incremental index (+embeddings when a key is configured), a
vector-table compaction when fewer than half its slots are live (the same step
as \`brain index --compact\`), an audit snapshot (the counts \`brain audit\`
reports, module hygiene checks included, with its must-fix and informational
totals), a stats snapshot (the day's
\`brain stats\` figures kept in .stats-history.jsonl, one per day — the same
step as \`brain stats --record\`), a tag report (counts only;
see \`brain tags\`), a git packing pass when the brain is a git work tree (git's
non-destructive loose-objects, incremental-repack and pack-refs tasks), then a
prune of the scratch area (files older than 7 days, then the oldest until
under 1 GB). Exits 2 if any step failed; the tag report never fails the run.
Module cron jobs are separate (advisory manifest entries consumed by the
container entrypoint).

  --no-git                Skip the git packing step

The hosting container runs this daily. A brain with no chat server has no
other periodic pass over the scratch area, so schedule this command (cron) or
scratch is pruned only when something writes into it.`;

export const maintainCommand: CoreCommand = {
  summary: "Run routine maintenance: registry tables, incremental index, vector compaction, audit snapshot, stats history, tag report, git packing, scratch prune",
  helpBlock: HELP,
  async run(args, cli): Promise<number> {
    const { args: pos, flags } = parseArgs(args);
    if (pos.length > 0) throw new UsageError(`brain maintain takes no positional arguments (got "${pos[0]}")`);
    const report: Array<{ step: string; result: string; trends?: StatsTrends }> = [];
    const dims = embeddingDims(cli.embeddings);

    // 0. Registry tables, before the index so it reads what they wrote. The
    // only markdown maintain writes: generated regions whose content changed.
    try {
      const result = runRegistry(cli.brain.root, cli.brain.taxonomy, { asOf: new Date().toISOString().slice(0, 10) });
      const summary = `${result.written.length} of ${result.indexes} table(s) rewritten`;
      report.push({
        step: "registry",
        result:
          result.invalid.length === 0
            ? `ok — ${summary}`
            : `FAILED — invalid registry: in ${result.invalid.map((p) => p.path).join(", ")}; ${summary}`,
      });
    } catch (e) {
      report.push({ step: "registry", result: `FAILED — ${(e as Error).message}` });
    }

    // 1. Incremental index (+embeddings when available — self-heals vectors).
    try {
      const db = openDatabase(cli.brain.dbPath, { embeddingDimensions: dims });
      let stats;
      try {
        await migrateVecSchema(db, storedVectorWidth(db, dims));
        const wantEmbeddings = !!cli.embeddings;
        stats = await indexAll(db, {
          root: cli.brain.root,
          taxonomy: cli.brain.taxonomy,
          force: false,
          quiet: true,
          embeddings: wantEmbeddings,
          provider: wantEmbeddings ? cli.embeddings : undefined,
          enrichment: wantEmbeddings ? cli.enrichment : undefined,
        });
      } finally {
        db.close();
      }
      report.push({
        step: "index",
        result: `ok — ${stats.added} added, ${stats.updated} updated, ${stats.deleted} deleted, ${stats.embeddings} embeddings`,
      });
    } catch (e) {
      report.push({ step: "index", result: `FAILED — ${(e as Error).message}` });
    }

    // 2. Vector compaction, only when it would reclaim something. Deleted
    // vectors leave slots sqlite-vec never reuses; see lib/indexer/compact.ts.
    try {
      const db = openDatabase(cli.brain.dbPath, { embeddingDimensions: dims });
      try {
        if (vecTableExists(db)) await loadVecSupport(db);
        const before = readVectorSlots(db);
        if (before.allocated === null) {
          report.push({ step: "vectors", result: "skipped — vector slots could not be read" });
        } else if (!needsCompaction(db, before)) {
          report.push({ step: "vectors", result: `ok — ${before.live} of ${before.allocated} slots live, nothing to reclaim` });
        } else {
          compactVectors(db);
          const after = readVectorSlots(db);
          report.push({
            step: "vectors",
            result: `ok — compacted ${before.allocated} slots to ${after.allocated} for ${after.live} live`,
          });
        }
      } finally {
        db.close();
      }
    } catch (e) {
      report.push({ step: "vectors", result: `FAILED — ${(e as Error).message}` });
    }

    // 3. Audit snapshot.
    try {
      const db = openDatabase(cli.brain.dbPath, { readonly: true });
      let issues;
      try {
        issues = await auditWithModules(db, cli.brain);
      } finally {
        db.close();
      }
      // The totals `brain audit --json` reports, from the same function.
      const { errors, warnings, infos, mustFix, informational } = auditTotals(issues);
      report.push({
        step: "audit",
        result: `${errors} error(s), ${warnings} warning(s), ${infos} info(s); ${mustFix} must-fix, ${informational} informational`,
      });
    } catch (e) {
      report.push({ step: "audit", result: `FAILED — ${(e as Error).message}` });
    }

    // 4. Stats history: the day's figures, after the index they describe. A
    // second run the same day replaces that day's snapshot.
    try {
      const recorded = await collectAndRecordStats(cli);
      report.push({ step: "stats", result: `ok — ${describeRecord(recorded)}`, trends: recorded.trends });
    } catch (e) {
      report.push({ step: "stats", result: `FAILED — ${(e as Error).message}` });
    }

    // 5. Tag report, counts only. Read-only, and never a failed step: a
    // tidy-up hint must not turn a cron run red.
    try {
      report.push({ step: "tags", result: summarizeTagReport(tagReport(cli.brain.root, cli.brain.taxonomy)) });
    } catch (e) {
      report.push({ step: "tags", result: `skipped — ${(e as Error).message}` });
    }

    // 6. Git packing. Loose objects pile up in a content repo because git's
    // automatic gc counts objects, not bytes; see lib/git-storage.ts. A brain
    // on a machine without git has no repository to pack, so a missing binary
    // skips; git refusing a repository it found fails.
    if (flags["no-git"] === true) {
      report.push({ step: "git", result: "skipped — --no-git" });
    } else {
      try {
        if (!isGitWorkTree(cli.brain.root)) {
          report.push({ step: "git", result: "skipped — not a git repository" });
        } else {
          const { packed } = packRepository(cli.brain.root);
          report.push({ step: "git", result: `ok — packed ${packed} loose object(s)` });
        }
      } catch (e) {
        const message = (e as Error).message;
        report.push({ step: "git", result: e instanceof GitUnavailableError ? `skipped — ${message}` : `FAILED — ${message}` });
      }
    }

    // 7. Scratch prune. Writes into scratch prune as they go; this is the
    // periodic pass, which the hosting cron runs daily through `maintain`.
    try {
      const pruned = pruneScratch(cli.brain.root);
      const summary = `removed ${pruned.removed.length} file(s), ${pruned.files} file(s) and ${pruned.bytes} bytes left`;
      report.push({
        step: "scratch",
        result:
          pruned.failed.length === 0
            ? `ok — ${summary}`
            : `FAILED — ${pruned.failed.length} file(s) could not be removed: ` +
              pruned.failed.map((f) => `${f.path} (${f.reason})`).join(", ") +
              `; ${summary}`,
      });
    } catch (e) {
      report.push({ step: "scratch", result: `FAILED — ${(e as Error).message}` });
    }

    emit(cli.json, report, () => {
      console.log("Maintenance run:\n");
      for (const r of report) {
        console.log(`  ${r.step.padEnd(10)} ${r.result}`);
        for (const v of r.trends?.verdicts ?? []) if (v.state === "warning") console.log(`    ${v.message}`);
      }
    });

    return report.some((r) => r.result.startsWith("FAILED")) ? 2 : 0;
  },
};
