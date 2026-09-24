import { openDatabase, migrateVecSchema, storedVectorWidth } from "../../lib/db.js";
import { indexAll } from "../../lib/indexer.js";
import { audit } from "../../lib/auditor.js";
import { pruneScratch } from "../../lib/scratch.js";
import type { CoreCommand } from "../types.js";
import { emit, embeddingDims } from "../io.js";

const HELP = `brain maintain — routine maintenance (cron-friendly)

Runs, in order: incremental index (+embeddings when a key is configured), an
audit snapshot, then a prune of the scratch area (files older than 7 days, then
the oldest until under 1 GB). Exits 2 if any step failed. Module cron jobs are separate
(advisory manifest entries consumed by the container entrypoint).`;

export const maintainCommand: CoreCommand = {
  summary: "Run routine maintenance: incremental index, audit snapshot, scratch prune",
  helpBlock: HELP,
  async run(_args, cli): Promise<number> {
    const report: Array<{ step: string; result: string }> = [];
    const dims = embeddingDims(cli.embeddings);

    // 1. Incremental index (+embeddings when available — self-heals vectors).
    try {
      const db = openDatabase(cli.brain.dbPath, { embeddingDimensions: dims });
      await migrateVecSchema(db, storedVectorWidth(db, dims));
      const wantEmbeddings = !!cli.embeddings;
      const stats = await indexAll(db, {
        root: cli.brain.root,
        taxonomy: cli.brain.taxonomy,
        force: false,
        quiet: true,
        embeddings: wantEmbeddings,
        provider: wantEmbeddings ? cli.embeddings : undefined,
        enrichment: wantEmbeddings ? cli.enrichment : undefined,
      });
      db.close();
      report.push({
        step: "index",
        result: `ok — ${stats.added} added, ${stats.updated} updated, ${stats.deleted} deleted, ${stats.embeddings} embeddings`,
      });
    } catch (e) {
      report.push({ step: "index", result: `FAILED — ${(e as Error).message}` });
    }

    // 2. Audit snapshot.
    try {
      const db = openDatabase(cli.brain.dbPath, { readonly: true });
      const issues = audit(db, cli.brain.taxonomy);
      db.close();
      const errors = issues.filter((i) => i.severity === "error").length;
      const warnings = issues.filter((i) => i.severity === "warning").length;
      const infos = issues.filter((i) => i.severity === "info").length;
      report.push({ step: "audit", result: `${errors} error(s), ${warnings} warning(s), ${infos} info(s)` });
    } catch (e) {
      report.push({ step: "audit", result: `FAILED — ${(e as Error).message}` });
    }

    // 3. Scratch prune. Writes into scratch prune as they go; this is the
    // periodic pass, which the hosting cron runs daily through `maintain`.
    try {
      const pruned = pruneScratch(cli.brain.root);
      report.push({
        step: "scratch",
        result: `ok — removed ${pruned.removed.length} file(s), ${pruned.files} file(s) and ${pruned.bytes} bytes left`,
      });
    } catch (e) {
      report.push({ step: "scratch", result: `FAILED — ${(e as Error).message}` });
    }

    emit(cli.json, report, () => {
      console.log("Maintenance run:\n");
      for (const r of report) console.log(`  ${r.step.padEnd(10)} ${r.result}`);
    });

    return report.some((r) => r.result.startsWith("FAILED")) ? 2 : 0;
  },
};
