import { existsSync, readFileSync } from "fs";

import { loadAuditDocs } from "../../lib/auditor.js";
import { openDatabase } from "../../lib/db.js";
import {
  detectCandidates,
  HygieneRefusal,
  readHygieneLog,
  reconcile,
  UNTIL_PATTERN,
  type HygieneCandidate,
  type HygieneDispositionRequest,
  type HygieneFix,
  type HygieneSeverity,
  type HygieneState,
  type ReconcileOptions,
} from "../../lib/hygiene.js";
import { indexAll } from "../../lib/indexer.js";
import type { CliContext, CoreCommand } from "../types.js";
import { emit, parseArgs, UsageError } from "../io.js";

const HELP = `brain hygiene <reconcile|list|dismiss|snooze> — the content-hygiene log under context/hygiene/

  reconcile [--extra <file.json>] [--fixed <file.json>] [--dry-run]
      Refresh the index, detect issues (brain audit, brain validate's corpus
      checks, silent edits, index table lag, and --extra candidates), join
      reports of the same problem into one finding with a stable ID, and
      apply the open/snoozed/dismissed/resolved state machine to the log,
      writing its files only where they change. --extra is a JSON array of
      { "category", "path", "evidence", "message" } with optional "severity"
      (error|warning|info) and "urgency"; --fixed is a JSON array of
      { "path", "fix" }, the auto-fixes to record in last-run.md. When a check
      cannot run (a module's check throws, validation or fact-drift cannot read
      its input), it is named in "failedChecks" and no entry is resolved
      unless it was detected again. --dry-run writes no log file; the
      index is still refreshed.
      --json envelope: { "opened", "reopened", "resolved", "stillOpen", "snoozed", "dismissed",
      "invalidated", "invalidations", "changedFiles", "detected": [{ "id", "category", "path",
      "message", "severity", "urgency", "sources", "fingerprint" }], "autoFixed", "failedChecks" }

  list [--state open|snoozed|dismissed|resolved]
      The log's entries.
      --json envelope: { "entries": [{ "id", "state", "path", "issue", "firstSeen",
      "lastSeen", "until", "dueAt", "resolvedBy", "resolvedOn", "sources", "severity",
      "fingerprint", "disposition", "invalidation" }] }

  dismiss <id> --expect-fingerprint <fp> [--reason <text>] [--extra <file.json>]
  snooze <id> --until <date|date-time> --expect-fingerprint <fp> [--reason <text>] [--extra <file.json>]
      Reconcile, then record the disposition in dismissed.md or snoozed.md
      with the fingerprint it applies to. A dismissed finding stays out of
      review until its evidence changes; a snoozed one until --until arrives
      (an ISO date, or a date-time with a zone) or its evidence changes. When
      the finding is not detected now, or its fingerprint is not <fp>, it is
      refused: exit 1, nothing written. A finding the skill reported through
      reconcile --extra is detected only with the same --extra file.
      --json envelope: { "status": "dismissed"|"snoozed", "id", "fingerprint", "until",
      "reason", "changedFiles" }; refused: { "status": "refused", "reason":
      "not-detected"|"stale-fingerprint", "id", "expectedFingerprint", "currentFingerprint" }`;

const STATES: HygieneState[] = ["open", "snoozed", "dismissed", "resolved"];
const SEVERITIES: HygieneSeverity[] = ["error", "warning", "info"];

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
    if (c.severity !== undefined && !SEVERITIES.includes(c.severity as HygieneSeverity)) {
      throw new UsageError(`--extra: entry ${i} has severity "${String(c.severity)}"; use error, warning or info`);
    }
    if (c.urgency !== undefined && (typeof c.urgency !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(c.urgency))) {
      throw new UsageError(`--extra: entry ${i} has urgency "${String(c.urgency)}"; use lowercase letters, digits and -`);
    }
    const candidate: HygieneCandidate = {
      category: c.category as string,
      path: c.path as string,
      evidence: c.evidence as string,
      message: c.message as string,
      source: { source: "skill", name: c.category as string, severity: (c.severity as HygieneSeverity | undefined) ?? null },
    };
    if (c.urgency !== undefined) candidate.urgency = c.urgency as string;
    return candidate;
  });
}

/** Refresh the index, detect, and reconcile; the database is closed again whatever happens. */
async function detectAndReconcile(cli: CliContext, opts: Omit<ReconcileOptions, "failedChecks">) {
  const db = openDatabase(cli.brain.dbPath);
  try {
    await indexAll(db, { root: cli.brain.root, taxonomy: cli.brain.taxonomy, force: false, quiet: true });
    const { candidates, failedChecks } = await detectCandidates(db, cli.brain, opts.now);
    const docs = new Map(loadAuditDocs(db).map((d) => [d.path, d]));
    return reconcile(cli.brain.root, candidates, docs, { ...opts, failedChecks });
  } finally {
    db.close();
  }
}

/** The disposition a `dismiss` or `snooze` asks for; malformed arguments are usage errors. */
function dispositionRequest(sub: "dismiss" | "snooze", pos: string[], flags: Record<string, string | boolean>, now: Date): HygieneDispositionRequest {
  const id = pos[1];
  if (!id || pos.length > 2) throw new UsageError(`Usage: brain hygiene ${sub} <id> --expect-fingerprint <fp>${sub === "snooze" ? " --until <date|date-time>" : ""}`);
  const expectFingerprint = flags["expect-fingerprint"];
  if (typeof expectFingerprint !== "string" || !/^[0-9a-f]{12}$/.test(expectFingerprint)) {
    throw new UsageError("--expect-fingerprint needs the 12-digit fingerprint brain hygiene list or reconcile reported");
  }
  if (flags.reason === true) throw new UsageError("--reason needs a text");
  const reason = typeof flags.reason === "string" ? flags.reason : undefined;
  if (sub === "dismiss") {
    if (flags.until !== undefined) throw new UsageError("--until is for brain hygiene snooze");
    return { kind: "dismissed", id, expectFingerprint, reason };
  }
  const until = flags.until;
  if (typeof until !== "string" || !UNTIL_PATTERN.test(until) || Number.isNaN(Date.parse(until))) {
    throw new UsageError("--until needs an ISO date (2026-10-12) or date-time with a zone (2026-10-12T08:00:00+02:00)");
  }
  const due = /T/.test(until) ? Date.parse(until) : Date.parse(`${until}T00:00:00Z`);
  if (due <= now.getTime()) throw new UsageError(`--until ${until} has already arrived; a snooze must end in the future`);
  return { kind: "snoozed", id, expectFingerprint, until, reason };
}

export const hygieneCommand: CoreCommand = {
  summary: "Reconcile, read and triage the content-hygiene log",
  helpBlock: HELP,
  async run(args, cli) {
    const { args: pos, flags } = parseArgs(args);
    const sub = pos[0];

    if (sub === "list") {
      const state = flags.state;
      if (state !== undefined && !STATES.includes(state as HygieneState)) {
        throw new UsageError("--state must be open, snoozed, dismissed or resolved");
      }
      const entries = readHygieneLog(cli.brain.root).filter((e) => state === undefined || e.state === state);
      emit(cli.json, { entries }, () => {
        if (entries.length === 0) console.log("No hygiene entries.");
        for (const e of entries) console.log(`${e.state.padEnd(8)} ${e.id}${e.path ? `  ${e.path}` : ""}`);
      });
      return 0;
    }

    if (sub === "dismiss" || sub === "snooze") {
      const now = new Date();
      const request = dispositionRequest(sub, pos, flags, now);
      if (flags.extra === true) throw new UsageError("--extra needs a file");
      // A finding the skill reported (`--extra`) is detected again only from the same candidates.
      const extra = typeof flags.extra === "string" ? readExtra(flags.extra) : [];
      try {
        const result = await detectAndReconcile(cli, { now, extra, dispositions: [request] });
        const payload = {
          status: request.kind,
          id: request.id,
          fingerprint: request.expectFingerprint,
          until: request.kind === "snoozed" ? request.until : null,
          reason: request.reason?.replace(/\s+/g, " ").trim() || null,
          changedFiles: result.changedFiles,
        };
        emit(cli.json, payload, () => {
          console.log(`${request.kind} ${request.id}${request.kind === "snoozed" ? ` until ${request.until}` : ""}`);
          for (const f of result.changedFiles) console.log(`  wrote ${f}`);
        });
        return 0;
      } catch (e) {
        if (!(e instanceof HygieneRefusal)) throw e;
        const refusal = {
          status: "refused",
          reason: e.reason,
          id: e.id,
          expectedFingerprint: e.expectedFingerprint,
          currentFingerprint: e.currentFingerprint,
        };
        emit(cli.json, refusal, () => console.error(e.message));
        return 1;
      }
    }

    if (sub !== "reconcile") throw new UsageError("Usage: brain hygiene <reconcile|list|dismiss|snooze>");
    if (flags.extra === true) throw new UsageError("--extra needs a file");
    if (flags.fixed === true) throw new UsageError("--fixed needs a file");
    const extra = typeof flags.extra === "string" ? readExtra(flags.extra) : [];
    const fixed = typeof flags.fixed === "string" ? readFixed(flags.fixed) : [];
    const dryRun = flags["dry-run"] === true;
    const result = await detectAndReconcile(cli, { now: new Date(), dryRun, extra, fixed });
    emit(cli.json, result, () => {
      const prefix = dryRun ? "[DRY-RUN] " : "";
      console.log(
        `${prefix}hygiene: ${result.opened} new, ${result.reopened} reopened, ${result.resolved} resolved, ` +
          `${result.stillOpen} still open, ${result.snoozed} snoozed, ${result.dismissed} dismissed` +
          (result.invalidated > 0 ? `, ${result.invalidated} back because their evidence changed` : "")
      );
      for (const name of result.failedChecks) console.log(`  check "${name}" could not run; entries not detected again were left as they are`);
      for (const f of result.changedFiles) console.log(`  ${dryRun ? "would write" : "wrote"} ${f}`);
    });
    return 0;
  },
};
