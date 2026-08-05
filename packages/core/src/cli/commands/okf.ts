import { resolve } from "path";

import {
  checkOkfBundle,
  exportOkfBundle,
  OkfExportError,
  type OkfCheckReport,
  type OkfExportReport,
} from "../../lib/okf-exporter.js";
import type { CoreCommand } from "../types.js";
import { emit, parseArgs, UsageError } from "../io.js";

const HELP = `brain okf — export and validate Open Knowledge Format v0.1 bundles

  brain okf export [--out <dir>] [--include <dir>]... [--exclude <dir>]... [--no-assets]
  brain okf check [<dir>]

Export defaults to okf-dist/ and mirrors the indexed content scope. Use
--exclude repeatedly before sharing a bundle to remove private domains.
The report always lists the included top-level directories for review.

The output directory must be inside the brain root and excluded from indexing.
check defaults to okf-dist/ and exits 1 when the bundle has conformance errors.

--json export envelope: OkfExportReport
--json check envelope:  { directory, ok, filesChecked, errors, warnings, issues }`;

function repeatedValues(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== `--${flag}`) continue;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new UsageError(`--${flag} requires a value`);
    values.push(value);
    i++;
  }
  return values;
}

function emitExport(json: boolean, report: OkfExportReport): void {
  emit(json, report, () => {
    console.log(`OKF bundle exported to ${report.outDir}`);
    console.log(`  Concepts: ${report.filesExported}`);
    console.log(`  Assets: ${report.assetsCopied}`);
    console.log(`  Links converted: ${report.linksConverted}`);
    console.log(`  Links degraded: ${report.linksDegraded}`);
    console.log(`  Index files: ${report.indexFilesGenerated}`);
    console.log(`  Included top-level directories: ${report.topLevelDirectories.join(", ") || "(root only)"}`);
    for (const item of report.degradedLinks) console.log(`  DEGRADED ${item.file}: [[${item.link}]]`);
    for (const warning of report.warnings) console.log(`  WARNING: ${warning}`);
  });
}

function emitCheck(json: boolean, report: OkfCheckReport): void {
  emit(json, report, () => {
    for (const issue of report.issues) {
      console.log(`[${issue.severity.toUpperCase()}] ${issue.path}: ${issue.message}`);
    }
    console.log(
      `OKF check: ${report.errors} error(s), ${report.warnings} warning(s), ${report.filesChecked} markdown file(s)`
    );
  });
}

export const okfCommand: CoreCommand = {
  summary: "Export or validate an Open Knowledge Format v0.1 bundle",
  helpBlock: HELP,
  async run(argv, cli) {
    const { args, flags } = parseArgs(argv);
    const verb = args[0];

    try {
      if (verb === "export") {
        if (args.length !== 1) throw new UsageError("Usage: brain okf export [flags]");
        if (cli.configError) throw new UsageError(`Invalid brain.config:\n${cli.configError}`);
        if (!cli.brain.configPath) {
          throw new UsageError("brain okf export requires an initialized brain.config");
        }
        if (flags.out === true) throw new UsageError("--out requires a value");

        const report = await exportOkfBundle({
          root: cli.brain.root,
          taxonomy: cli.brain.taxonomy,
          outDir: typeof flags.out === "string" ? flags.out : undefined,
          include: repeatedValues(argv, "include"),
          exclude: repeatedValues(argv, "exclude"),
          copyAssets: flags["no-assets"] !== true,
        });
        emitExport(cli.json, report);
        return 0;
      }

      if (verb === "check") {
        if (args.length > 2) throw new UsageError("Usage: brain okf check [<dir>]");
        const requested = args[1] ?? "okf-dist";
        const directory = resolve(cli.brain.root, requested);
        const report = checkOkfBundle(directory);
        emitCheck(cli.json, report);
        return report.errors > 0 ? 1 : 0;
      }
    } catch (error) {
      if (error instanceof OkfExportError) throw new UsageError(error.message);
      throw error;
    }

    throw new UsageError("Usage: brain okf export|check");
  },
};
