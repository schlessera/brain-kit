import { existsSync, readFileSync } from "fs";

import { loadAuditDocs } from "../../lib/auditor.js";
import { openDatabase } from "../../lib/db.js";
import {
  detectCandidates,
  readHygieneLog,
  reconcile,
  type HygieneCandidate,
  type HygieneFix,
  type HygieneState,
} from "../../lib/hygiene.js";
import { indexAll } from "../../lib/indexer.js";
import type { CoreCommand } from "../types.js";
import { emit, parseArgs, UsageError } from "../io.js";

const HELP = `brain hygiene <reconcile|list> — the content-hygiene log under context/hygiene/

  reconcile [--extra <file.json>] [--fixed <file.json>] [--dry-run]
      Refresh the index, detect issues (brain audit, silent edits, index table
      lag, and --extra candidates), give each a stable ID, apply the
      open/snoozed/resolved state machine to the log, and write the log's
      files only where they change. --extra is a JSON array of
      { "category", "path", "evidence", "message" }; --fixed is a JSON array of
      { "path", "fix" }, the auto-fixes to record in last-run.md. When a check
      cannot run (a module's check throws, or fact-drift cannot read a
      canonical file), it is named in "failedChecks" and no entry is resolved
      unless it was detected again. --dry-run writes no log file; the
      index is still refreshed.
      --json envelope: { "opened", "reopened", "resolved", "stillOpen", "snoozed", "changedFiles",
      "detected": [{ "id", "category", "path", "message" }], "autoFixed", "failedChecks" }

  list [--state open|snoozed|resolved]
      The log's entries.
      --json envelope: { "entries": [{ "id", "state", "path", "issue", "firstSeen",
      "lastSeen", "until", "resolvedBy", "resolvedOn" }] }`;

const STATES: HygieneState[] = ["open", "snoozed", "resolved"];

/** A JSON array from a --extra or --fixed file. Anything malformed is a usage error, before any write. */
function readArray(flag: string, path: string): unknown[] {
  if (!existsSync(path)) throw new UsageError(`--${flag}: no such file: ${path}`);
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    throw new UsageError(`--${flag}: ${path} is not JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(data)) throw new UsageError(`--${flag}: ${path} must hold a JSON array`);
  return data;
}

function readFixed(path: string): HygieneFix[] {
  return readArray("fixed", path).map((item, i) => {
    const f = item as Record<string, unknown>;
    for (const key of ["path", "fix"]) {
      if (typeof f?.[key] !== "string" || (f[key] as string).trim() === "") {
        throw new UsageError(`--fixed: entry ${i} needs a non-empty string "${key}"`);
      }
    }
    return { path: f.path, fix: f.fix } as HygieneFix;
  });
}

function readExtra(path: string): HygieneCandidate[] {
  return readArray("extra", path).map((item, i) => {
    const c = item as Record<string, unknown>;
    for (const key of ["category", "path", "evidence", "message"]) {
      if (typeof c?.[key] !== "string" || (key !== "evidence" && (c[key] as string).trim() === "")) {
        throw new UsageError(`--extra: entry ${i} needs a string "${key}"`);
      }
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(c.category as string)) {
      throw new UsageError(`--extra: entry ${i} has category "${String(c.category)}"; use lowercase letters, digits and -`);
    }
    return { category: c.category, path: c.path, evidence: c.evidence, message: c.message } as HygieneCandidate;
  });
}

export const hygieneCommand: CoreCommand = {
  summary: "Reconcile and read the content-hygiene log",
  helpBlock: HELP,
  async run(args, cli) {
    const { args: pos, flags } = parseArgs(args);
    const sub = pos[0];

    if (sub === "list") {
      const state = flags.state;
      if (state !== undefined && !STATES.includes(state as HygieneState)) {
        throw new UsageError("--state must be open, snoozed or resolved");
      }
      const entries = readHygieneLog(cli.brain.root).filter((e) => state === undefined || e.state === state);
      emit(cli.json, { entries }, () => {
        if (entries.length === 0) console.log("No hygiene entries.");
        for (const e of entries) console.log(`${e.state.padEnd(8)} ${e.id}${e.path ? `  ${e.path}` : ""}`);
      });
      return 0;
    }

    if (sub !== "reconcile") throw new UsageError("Usage: brain hygiene <reconcile|list>");
    if (flags.extra === true) throw new UsageError("--extra needs a file");
    if (flags.fixed === true) throw new UsageError("--fixed needs a file");
    const extra = typeof flags.extra === "string" ? readExtra(flags.extra) : [];
    const fixed = typeof flags.fixed === "string" ? readFixed(flags.fixed) : [];
    const dryRun = flags["dry-run"] === true;
    const now = new Date();

    const db = openDatabase(cli.brain.dbPath);
    try {
      await indexAll(db, { root: cli.brain.root, taxonomy: cli.brain.taxonomy, force: false, quiet: true });
      const { candidates, failedChecks } = await detectCandidates(db, cli.brain, now);
      const docs = new Map(loadAuditDocs(db).map((d) => [d.path, d]));
      const result = reconcile(cli.brain.root, candidates, docs, { now, dryRun, extra, fixed, failedChecks });
      emit(cli.json, result, () => {
        const prefix = dryRun ? "[DRY-RUN] " : "";
        console.log(
          `${prefix}hygiene: ${result.opened} new, ${result.reopened} reopened, ${result.resolved} resolved, ` +
            `${result.stillOpen} still open, ${result.snoozed} snoozed`
        );
        for (const name of result.failedChecks) console.log(`  check "${name}" could not run; entries not detected again were left as they are`);
        for (const f of result.changedFiles) console.log(`  ${dryRun ? "would write" : "wrote"} ${f}`);
      });
      return 0;
    } finally {
      db.close();
    }
  },
};
