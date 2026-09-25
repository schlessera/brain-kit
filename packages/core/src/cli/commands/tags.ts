import { openDatabase } from "../../lib/db.js";
import { indexAll } from "../../lib/indexer.js";
import { tagReport } from "../../lib/tags.js";
import type { TagReport } from "../../lib/tags.js";
import { applyTagChanges } from "../../lib/tags-apply.js";
import type { TagApplyReport } from "../../lib/tags-apply.js";
import type { CoreCommand } from "../types.js";
import { emit, parseArgs, UsageError } from "../io.js";

const HELP = `brain tags — report tag variants, redundant tags and vocabulary drift (read-only)

Reads every document's frontmatter tags and reports:
  variant groups     tags that normalize to one key (-/_ stripped, English
                     singular, small spelling distance), with a proposed canonical
  redundant tags     a tag equal to the document's type or a directory of its path
  alias hits         a tag that is a key of taxonomy.tags.aliases
  out of vocabulary  tags outside taxonomy.tags.vocabulary, when one is set

Nothing is rewritten. Configure the vocabulary under taxonomy.tags in brain.config.

--json envelope: { "tags", "documents", "variantGroups", "redundant", "aliasHits", "outOfVocabulary" }

brain tags --apply — migrate frontmatter tags to their canonical forms

Applies every taxonomy.tags.aliases entry, and every variant group whose
proposed canonical is in the vocabulary. Only the tags entries of each file
change: every other byte, the updated date included, stays as it was. The
touched files are reindexed and their mtimes accepted, so they do not show up
as silently modified.

  --groups                Apply every variant group, in the vocabulary or not
  --redundant             Also remove tags that repeat the document's type or directory
  --only <old>            Only change this one old tag
  --dry-run               Report what would change and write nothing

--json envelope: { "files": [{ "path", "from", "to" }], "skipped": [{ "path", "reason" }] }`;

/** The one-line count summary `brain maintain` prints for its tags step. */
export function summarizeTagReport(report: TagReport): string {
  const parts = [
    `${report.variantGroups.length} variant group(s)`,
    `${report.redundant.length} redundant tag(s)`,
    `${report.aliasHits.length} alias hit(s)`,
  ];
  if (report.outOfVocabulary) parts.push(`${report.outOfVocabulary.length} out-of-vocabulary tag(s)`);
  return parts.join(", ");
}

function printHuman(report: TagReport): void {
  console.log(`${report.tags} tag(s) across ${report.documents} document(s): ${summarizeTagReport(report)}`);

  if (report.variantGroups.length > 0) {
    console.log("\nVariant groups (proposed canonical first):");
    for (const group of report.variantGroups) {
      const others = group.members.filter((m) => m.tag !== group.canonical);
      const keep = group.members.find((m) => m.tag === group.canonical)!;
      console.log(
        `  ${keep.tag} (${keep.count}) ← ${others.map((m) => `${m.tag} (${m.count})`).join(", ")}`
      );
    }
  }
  if (report.redundant.length > 0) {
    console.log("\nRedundant tags:");
    for (const r of report.redundant) console.log(`  ${r.path}: ${r.tag} (repeats its ${r.repeats})`);
  }
  if (report.aliasHits.length > 0) {
    console.log("\nAlias hits:");
    for (const a of report.aliasHits) console.log(`  ${a.path}: ${a.tag} → use ${a.canonical}`);
  }
  if (report.outOfVocabulary && report.outOfVocabulary.length > 0) {
    console.log("\nOut of vocabulary:");
    for (const t of report.outOfVocabulary) console.log(`  ${t.tag} (${t.count})`);
  }
}

function printApply(report: TagApplyReport, dryRun: boolean): void {
  const verb = dryRun ? "Would rewrite" : "Rewrote";
  console.log(`${verb} tags in ${report.files.length} file(s).`);
  for (const f of report.files) console.log(`  ${f.path}: [${f.from.join(", ")}] → [${f.to.join(", ")}]`);
  if (report.skipped.length > 0) {
    console.log(`\nSkipped ${report.skipped.length} file(s):`);
    for (const s of report.skipped) console.log(`  ${s.path}: ${s.reason}`);
  }
}

export const tagsCommand: CoreCommand = {
  summary: "Report tag variants, redundant tags and vocabulary drift (read-only)",
  helpBlock: HELP,
  async run(args, cli) {
    const { args: pos, flags } = parseArgs(args);
    if (pos.length > 0) throw new UsageError(`brain tags takes no positional arguments (got "${pos[0]}")`);

    if (flags.apply === true) {
      if (flags.only === true) throw new UsageError("--only needs a tag");
      const dryRun = flags["dry-run"] === true;
      const applied = applyTagChanges(cli.brain.root, cli.brain.taxonomy, {
        groups: flags.groups === true,
        redundant: flags.redundant === true,
        only: typeof flags.only === "string" ? flags.only : undefined,
        dryRun,
      });
      if (!dryRun && applied.files.length > 0) {
        // A tag rename is mechanical: `updated` stays, the index picks up the
        // new tags, and the new mtimes are accepted (packages/core/CONTRACT.md).
        const db = openDatabase(cli.brain.dbPath);
        try {
          await indexAll(db, { root: cli.brain.root, taxonomy: cli.brain.taxonomy, force: false, quiet: true });
          const accept = db.prepare(
            "UPDATE documents SET accepted_mtime = file_mtime WHERE path = ? AND file_mtime IS NOT NULL"
          );
          for (const f of applied.files) accept.run(f.path);
        } finally {
          db.close();
        }
      }
      emit(cli.json, applied, () => printApply(applied, dryRun));
      return 0;
    }
    for (const flag of ["dry-run", "only", "groups", "redundant"]) {
      if (flags[flag] !== undefined) throw new UsageError(`--${flag} only applies with --apply`);
    }

    const report = tagReport(cli.brain.root, cli.brain.taxonomy);
    emit(cli.json, report, () => printHuman(report));
    return 0;
  },
};
