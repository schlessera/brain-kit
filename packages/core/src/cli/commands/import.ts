import { readFileSync, statSync, writeFileSync } from "fs";
import { resolve } from "path";
import { Glob } from "bun";

import { stringifyDocument } from "../../lib/frontmatter";
import { safeResolve } from "../../lib/safe-path";
import type { CoreCommand } from "../types";
import { emit, parseArgs, UsageError } from "../io";

const HELP = `brain import --stamp <dir> — mechanical frontmatter stamping for imports

Stamps every un-frontmattered *.md under <dir> with: type=<inbox type>,
status=draft, title from the first H1 (else the filename), created/updated from
the file mtime. Files that already have frontmatter are skipped. JSON report.`;

/** First-H1 title, else a prettified filename. */
function deriveTitle(raw: string, filename: string): string {
  for (const line of raw.split("\n")) {
    const m = line.match(/^#\s+(.+)$/);
    if (m) return m[1].trim();
    if (line.trim()) break; // first non-blank line wasn't an H1
  }
  return filename.replace(/\.md$/, "").replace(/[-_]+/g, " ").trim() || filename;
}

export const importCommand: CoreCommand = {
  summary: "Mechanical frontmatter stamping for imported markdown",
  helpBlock: HELP,
  async run(args, cli) {
    const { flags } = parseArgs(args);
    const dir = flags.stamp;
    if (typeof dir !== "string" || !dir) {
      throw new UsageError("Usage: brain import --stamp <dir>");
    }

    const base = safeResolve(cli.brain.root, dir);
    if (base === null) {
      throw new UsageError(`--stamp directory escapes the brain root: ${dir}`);
    }
    const inboxType = cli.brain.taxonomy.inboxType();

    const stamped: string[] = [];
    const skipped: string[] = [];
    const errors: Array<{ file: string; message: string }> = [];

    const glob = new Glob("**/*.md");
    for (const rel of glob.scanSync({ cwd: base })) {
      const full = resolve(base, rel);
      try {
        const raw = readFileSync(full, "utf-8");
        if (raw.startsWith("---")) {
          skipped.push(rel);
          continue;
        }
        const filename = rel.split("/").pop()!;
        const day = statSync(full).mtime.toISOString().split("T")[0];
        const frontmatter = {
          type: inboxType,
          title: deriveTitle(raw, filename),
          created: day,
          updated: day,
          status: "draft",
          tags: [] as string[],
        };
        writeFileSync(full, stringifyDocument(`\n${raw.trim()}\n`, frontmatter), "utf-8");
        stamped.push(rel);
      } catch (e) {
        errors.push({ file: rel, message: (e as Error).message });
      }
    }

    emit(cli.json, { dir, stamped, skipped, errors }, () => {
      console.log(`brain import --stamp ${dir}:`);
      console.log(`  stamped: ${stamped.length}`);
      console.log(`  skipped (already had frontmatter): ${skipped.length}`);
      if (errors.length) console.log(`  errors: ${errors.length}`);
    });
  },
};
