import { tagReport } from "../../lib/tags.js";
import type { TagReport } from "../../lib/tags.js";
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

--json envelope: { "tags", "documents", "variantGroups", "redundant", "aliasHits", "outOfVocabulary" }`;

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

export const tagsCommand: CoreCommand = {
  summary: "Report tag variants, redundant tags and vocabulary drift (read-only)",
  helpBlock: HELP,
  async run(args, cli) {
    const { args: pos } = parseArgs(args);
    if (pos.length > 0) throw new UsageError(`brain tags takes no positional arguments (got "${pos[0]}")`);
    const report = tagReport(cli.brain.root, cli.brain.taxonomy);
    emit(cli.json, report, () => printHuman(report));
    return 0;
  },
};
