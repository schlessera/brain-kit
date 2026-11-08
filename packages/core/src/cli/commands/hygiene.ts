import { existsSync, readFileSync } from "fs";
import { relative, sep } from "path";

import { audit, loadAuditDocs } from "../../lib/auditor.js";
import { openDatabase } from "../../lib/db.js";
import {
  canonicalFindings,
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
import { selectHygieneNext } from "../../lib/hygiene-next.js";
import { checkHygiene, CONFIG_BLOCKER_ID, repairHandlers, resolveHygiene, undoHygiene } from "../../lib/hygiene-repair.js";
import { indexAll } from "../../lib/indexer.js";
import { mediaPolicy } from "../../lib/media.js";
import { reviewPropagations, type PropagationReviewReport } from "../../lib/propagation-review.js";
import type { MediaAction } from "../../lib/media-effects.js";
import { mediaReferenceLimits } from "../../lib/media-references.js";
import { resolveEnv } from "../../config/env.js";
import type { CliContext, CoreCommand } from "../types.js";
import { emit, parseArgs, UsageError } from "../io.js";

const HELP = `brain hygiene <reconcile|propagation|list|next|dismiss|snooze|keep-copy|unkeep|media|resolve|undo|check> — the content-hygiene log under context/hygiene/

  propagation [--dry-run]
      Inspect or run diff-assisted freshness review after persistent opt-in
      (hygiene.propagation.enabled). Reports settings, typed judgments and
      threshold sensitivity. Dry-run may call Jev but writes no Markdown.
      Only a matching separate review receipt clears propagation; document
      content and updated dates are untouched. Unknowns remain for the owner.
      Ordinary reconcile/next run this prepass automatically when enabled;
      inspection-only next --dry-run never initiates provider calls.

  reconcile [--extra <file.json>] [--fixed <file.json>] [--dry-run]
      Refresh the index, detect issues (brain audit, brain validate's corpus
      checks, silent edits, index table lag, and --extra candidates), join
      reports of the same problem into one finding with a stable ID, and
      apply the open/snoozed/dismissed/kept/resolved state machine to the
      log, writing its files only where they change. Media awaiting a decision
      (the uncommitted MEDIA and LARGE files sync assesses, plus the scratch
      files a conversation links) are findings of category "media"; a kept
      entry (kept.md) holds while its permanent copy exists and is tracked. --extra is a JSON array of
      { "category", "path", "evidence", "message" } with optional "severity"
      (error|warning|info) and "urgency"; --fixed is a JSON array of
      { "path", "fix" }, the auto-fixes to record in last-run.md. When a check
      cannot run (a module's check throws, validation or fact-drift cannot read
      its input), it is named in "failedChecks" and no entry is resolved
      unless it was detected again. --dry-run writes no log file; the
      index is still refreshed.
      --json envelope: { "opened", "reopened", "resolved", "stillOpen", "snoozed", "dismissed",
      "invalidated", "invalidations", "changedFiles", "detected": [{ "id", "category", "path",
      "message", "severity", "urgency", "sources", "fingerprint" }], "autoFixed", "failedChecks",
      "kept" }

  next [--extra <file.json>] [--finding <id> --dry-run] [--defer <id>=<fp>,...]
      Reconcile and select one eligible canonical finding by severity, known
      urgency, age, then identity. Informational findings are counted but not
      shown, except media, which is always shown. The finding's handlers
      describe every available repair or manual choice; handler remains
      "manual" for compatibility. --defer skips findings left pending this
      review pass while their fingerprint is still <fp>. Returns
      { "finding", "counts", "media": { "awaitingReview", "setAside", "kept",
      "links" } }, the same media counts brain sync reports; invalid configuration returns
      { "blocker": { "kind": "configuration", "message", "path", "line", "column" } }
      with exit 1 before any indexing or hygiene writes.
      --finding <id> --dry-run reads that detected open finding without
      Markdown writes, preserving the log for counts; the index is refreshed.

  list [--state open|snoozed|dismissed|resolved|kept]
      The log's entries.
      --json envelope: { "entries": [{ "id", "state", "path", "issue", "firstSeen",
      "lastSeen", "until", "dueAt", "resolvedBy", "resolvedOn", "sources", "severity",
      "fingerprint", "disposition", "invalidation", "copy", "copySha256", "keptOn" }] }

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
      "not-detected"|"stale-fingerprint", "id", "expectedFingerprint", "currentFingerprint" }

  keep-copy <id> --expect-fingerprint <fp> --copy <path> --copy-sha256 <sha256> --journal <id> [--reason <text>]
      Reconcile, then record a media finding as kept (kept.md): its permanent
      copy at <path> was made and verified by Keep a permanent copy. Refused,
      with nothing written, unless the copy is a contained regular file outside
      .brain/ and workspaces/, media.track keeps it, and it holds <sha256>.
      --json envelope: as dismiss, with "status": "kept", "copy", "copySha256"
      and "journal" appended; refused reasons add "not-media", "copy-missing",
      "copy-untracked" and "copy-changed".

  unkeep <id> --journal <id>
      Reconcile, then remove the kept entry that keep-copy recorded for <id>
      under that journal ID: Undo of Keep a permanent copy, after the copy and
      its config are restored. The original is open again, without an
      invalidation receipt. Refused, with nothing written, when no such kept
      entry exists.
      --json envelope: { "status": "unkept", "id", "journal", "changedFiles" };
      refused: { "status": "refused", "reason": "not-kept", "id", "journal" }`;

const MEDIA_HELP = `
  media <delete|move|persist|keep-copy> <id> --expect-fingerprint <fp> [--to <path>]
      [--pattern <glob> [--ignore-adjust <entry>]]
      [--dry-run | --expect-premise <digest> --journal <id> [--expect-approval <digest>]]
      A media finding's effect (#2781). --dry-run plans it and writes nothing:
      { "status": "preview", "id", "action", "fingerprint", "source", "destination",
      "links", "references", "rewrites", "blockers", "configDiff", "scope",
      "pattern", "ignoreAdjust", "matches", "approvalDigest", "captureBytes",
      "copy", "resultClass", "files", "premiseDigest", "refusals" }. move and
      keep-copy need --to. persist and keep-copy track the file by its exact
      path; --pattern tracks it by a broader media.track rule that matches it,
      and --ignore-adjust removes the one broader media.ignore entry that would
      still win. A broader change previews its current matches ("matches") and
      an approvalDigest that apply needs back as --expect-approval; a change
      since is "stale-approval". Apply needs the preview's premiseDigest and the
      caller's journal ID: the caller retains every listed pre-image first and
      compensates from it; this command never does. Apply returns { "status":
      "applied"|"stale"|"refused"|"interrupted", "id", "action", "journal",
      "reason", "refusals", "files": [{ ..., "state" }], "copySha256" }.
      keep-copy writes the copy and its config only; brain hygiene keep-copy
      records the kept entry after the caller has verified it.
`;

const REPAIR_HELP = `
  resolve <id> --handler link-suggested|link-note|link-text|required-field
      --input <json> --expect-fingerprint <fp> [--dry-run | --expect-preview <token>]
      Preview exact bytes without writes, then apply that preview's bounded
      effect after premise revalidation. A failed post-check leaves the finding
      open and returns an undoToken. No automatic Undo.
  undo <undoToken> [--dry-run]
      Preview or confirm the inverse effect. Refuses if the file changed.
  check <id>
      Check one finding. Still detected/failed checks write nothing; only a
      successful check records resolved-by: check. Use configuration-blocker
      to recheck invalid brain.config without writing anything.
`;

const STATES: HygieneState[] = ["open", "snoozed", "dismissed", "resolved", "kept"];
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
    let { candidates, failedChecks, media } = await detectCandidates(db, cli.brain, opts.now);
    let propagation: PropagationReviewReport | undefined;
    if (!opts.dryRun && !opts.dispositions && !failedChecks.length && cli.brain.config?.hygiene?.propagation?.enabled === true) {
      propagation = await reviewPropagations(cli.brain, candidates.filter(c => c.category === "propagation").map(c => c.path), { now: opts.now });
      if (propagation.changedFiles.length) ({ candidates, failedChecks, media } = await detectCandidates(db, cli.brain, opts.now));
    }
    const docs = new Map(loadAuditDocs(db).map((d) => [d.path, d]));
    const result = reconcile(cli.brain.root, candidates, docs, { ...opts, failedChecks, media: mediaPolicy(cli.brain.config) });
    if (propagation) {
      result.changedFiles = [...new Set([...result.changedFiles, ...propagation.changedFiles])];
    }
    return { result: propagation ? { ...result, propagation } : result, findings: canonicalFindings([...candidates, ...(opts.extra ?? [])]), inventory: media };
  } finally {
    db.close();
  }
}

/** `--defer id=fp,...`: the findings left pending this review pass, at the fingerprint they were left at. */
function readDeferred(value: string | boolean | undefined): Map<string, string> {
  if (value === undefined) return new Map();
  if (typeof value !== "string" || value === "") throw new UsageError("--defer needs <id>=<fingerprint>[,<id>=<fingerprint>...]");
  return new Map(value.split(",").map((pair) => {
    const m = /^([a-z0-9][a-z0-9_-]*-[0-9a-f]{4})=([0-9a-f]{12})$/.exec(pair);
    if (!m) throw new UsageError(`--defer: "${pair}" is not <id>=<12-digit fingerprint>`);
    return [m[1]!, m[2]!] as const;
  }));
}

/** The disposition a `dismiss`, `snooze` or `keep-copy` asks for; malformed arguments are usage errors. */
function dispositionRequest(sub: "dismiss" | "snooze" | "keep-copy", pos: string[], flags: Record<string, string | boolean>, now: Date): HygieneDispositionRequest {
  const id = pos[1];
  if (!id || pos.length > 2) throw new UsageError(`Usage: brain hygiene ${sub} <id> --expect-fingerprint <fp>${sub === "snooze" ? " --until <date|date-time>" : ""}`);
  const expectFingerprint = flags["expect-fingerprint"];
  if (typeof expectFingerprint !== "string" || !/^[0-9a-f]{12}$/.test(expectFingerprint)) {
    throw new UsageError("--expect-fingerprint needs the 12-digit fingerprint brain hygiene list or reconcile reported");
  }
  if (flags.reason === true) throw new UsageError("--reason needs a text");
  const reason = typeof flags.reason === "string" ? flags.reason : undefined;
  if (sub !== "keep-copy" && (flags.copy !== undefined || flags["copy-sha256"] !== undefined || flags.journal !== undefined)) {
    throw new UsageError("--copy, --copy-sha256 and --journal are for brain hygiene keep-copy");
  }
  if (sub === "keep-copy") {
    if (flags.until !== undefined) throw new UsageError("--until is for brain hygiene snooze");
    const copy = flags.copy, sha = flags["copy-sha256"], journal = flags.journal;
    if (typeof copy !== "string" || copy === "" || copy.startsWith("/")) throw new UsageError("--copy needs the copy's repo-relative path");
    if (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)) throw new UsageError("--copy-sha256 needs the copy's 64-digit SHA-256");
    if (typeof journal !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(journal)) throw new UsageError("--journal needs the effect's journal ID");
    return { kind: "kept", id, expectFingerprint, copy, copySha256: sha, journal, reason };
  }
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
  helpBlock: HELP + MEDIA_HELP + REPAIR_HELP,
  async run(args, cli) {
    const { args: pos, flags } = parseArgs(args);
    const sub = pos[0];

    if (sub === "propagation") {
      if (pos.length !== 1) throw new UsageError("Usage: brain hygiene propagation [--dry-run]");
      let paths: string[] = [];
      if (cli.brain.config?.hygiene?.propagation?.enabled === true) {
        const db = openDatabase(cli.brain.dbPath);
        try {
          await indexAll(db, { root: cli.brain.root, taxonomy: cli.brain.taxonomy, quiet: true, embeddings: false });
          // Raw lag finds cached judgments too; ordinary audit applies receipts read-only.
          paths = audit(db, cli.brain.taxonomy, { root: cli.brain.root }).filter(i => i.category === "propagation").map(i => i.path);
        } finally { db.close(); }
      }
      const report = await reviewPropagations(cli.brain, paths, { dryRun: flags["dry-run"] === true });
      emit(cli.json, report, () => {
        console.log(report.enabled ? `${report.acknowledged} current, ${report.reviewRequired} need review, ${report.unavailable} unavailable, ${report.deferred} deferred` : "Propagation automation is disabled; enable hygiene.propagation.enabled explicitly.");
        for (const item of report.findings) console.log(`${item.status}: ${item.path} (${item.reason}${item.cached ? ", cached" : ""})`);
      });
      return 0;
    }

    if (sub === "next") {
      if (pos.length !== 1) throw new UsageError("Usage: brain hygiene next [--extra <file.json>] [--finding <id> --dry-run]");
      if (cli.configError) {
        const cause = cli.configCause as {
          sourceURL?: unknown; line?: unknown; column?: unknown;
          position?: { file?: unknown; line?: unknown; column?: unknown };
        } | undefined;
        // Bun BuildMessage uses a 1-based position; ordinary runtime errors
        // use sourceURL. Never pass through the config loader's own stack line.
        const location = cause?.position?.file === cli.brain.configPath ? cause.position
          : cause?.sourceURL === cli.brain.configPath ? cause : undefined;
        const payload = { blocker: {
          kind: "configuration",
          message: cli.configError,
          path: cli.brain.configPath,
          line: typeof location?.line === "number" ? location.line : null,
          column: typeof location?.column === "number" ? location.column : null,
        } };
        emit(cli.json, payload, () => console.error(`Review cannot start: ${cli.configError}`));
        return 1;
      }
      if (flags.extra === true) throw new UsageError("--extra needs a file");
      const extra = typeof flags.extra === "string" ? readExtra(flags.extra) : [];
      const now = new Date();
      if (flags.finding !== undefined && (typeof flags.finding !== "string" || !flags.finding || flags["dry-run"] !== true))
        throw new UsageError("--finding needs an ID and --dry-run");
      const deferred = readDeferred(flags.defer);
      const { result, findings, inventory } = await detectAndReconcile(cli, { now, extra, dryRun: flags["dry-run"] === true });
      if (result.failedChecks.length > 0) {
        emit(cli.json, { blocker: { kind: "checks", failedChecks: result.failedChecks } }, () => console.error(`Review cannot start: checks failed: ${result.failedChecks.join(", ")}`));
        return 1;
      }
      const selected = selectHygieneNext(cli.brain.root, findings, readHygieneLog(cli.brain.root), now, typeof flags.finding === "string" ? flags.finding : undefined,
        { media: mediaPolicy(cli.brain.config), inventory, deferred });
      const payload = { ...selected, finding: selected.finding
        ? { ...selected.finding, handlers: repairHandlers(cli.brain, selected.finding) } : null };
      emit(cli.json, payload, () => {
        console.log(payload.finding ? `${payload.finding.id}: ${payload.finding.title}` : "No open findings.");
        console.log(`${payload.counts.eligibleRemaining} eligible, ${payload.counts.fixed} resolved, ${payload.counts.dismissed} dismissed, ${payload.counts.snoozed} snoozed, ${payload.counts.informationalNotShown} informational not shown`);
      });
      return 0;
    }
    if (sub === "check") {
      if (!pos[1] || pos.length !== 2) throw new UsageError("Usage: brain hygiene check <id>");
      const blockerReason = cli.configError ?? (cli.brain.configPath === null ? "No brain.config found; configure the brain before review." : undefined);
      const result = pos[1] === CONFIG_BLOCKER_ID
        ? { status: blockerReason ? "blocked" : "ready", id: CONFIG_BLOCKER_ID,
            handler: { name: "blocker", category: "configuration", kind: "blocker", input: { type: "none" }, effect: "No write", postCheck: "configuration-load", path: cli.brain.configPath, line: null, explanation: blockerReason ?? "Configuration loads; review may start." },
            ...(blockerReason ? { reason: blockerReason } : {}) }
        : await checkHygiene(cli.brain, pos[1]);
      emit(cli.json, result, () => console.log(`${result.status}: ${result.id}`));
      return ["blocked", "check_failed", "refused"].includes(result.status) ? 1 : 0;
    }
    if (sub === "resolve" || sub === "undo") {
      if (!pos[1] || pos.length !== 2) throw new UsageError(`Usage: brain hygiene ${sub} <${sub === "undo" ? "undoToken" : "id"}>`);
      const dryRun = flags["dry-run"] === true;
      let result;
      if (sub === "undo") result = undoHygiene(cli.brain, pos[1], dryRun);
      else {
        if (typeof flags.handler !== "string" || typeof flags.input !== "string" || typeof flags["expect-fingerprint"] !== "string") throw new UsageError("resolve needs --handler, --input <json> and --expect-fingerprint");
        if (!dryRun && typeof flags["expect-preview"] !== "string") throw new UsageError("Preview with --dry-run first, then supply --expect-preview <previewToken>");
        let input: unknown;
        try { input = JSON.parse(flags.input); } catch { throw new UsageError("--input must be JSON"); }
        result = await resolveHygiene(cli.brain, { id: pos[1], handler: flags.handler, input,
          expectFingerprint: flags["expect-fingerprint"], expectPreview: typeof flags["expect-preview"] === "string" ? flags["expect-preview"] : undefined, dryRun });
      }
      emit(cli.json, result, () => console.log(JSON.stringify(result, null, 2)));
      return ["fixed", "preview", "undone"].includes(result.status) ? 0 : 1;
    }

    if (sub === "media") {
      // Loaded only for this verb: the effect module's dependencies stay out of every other one.
      const { applyMediaEffect, MEDIA_ACTIONS, planMediaEffect } = await import("../../lib/media-effects.js");
      const action = pos[1], id = pos[2];
      if (!MEDIA_ACTIONS.includes(action as MediaAction) || !id || pos.length !== 3) {
        throw new UsageError("Usage: brain hygiene media <delete|move|persist|keep-copy> <id> --expect-fingerprint <fp> [--to <path>] [--pattern <glob> [--ignore-adjust <entry>]] [--dry-run | --expect-premise <digest> --journal <id> [--expect-approval <digest>]]");
      }
      for (const flag of ["pattern", "ignore-adjust", "expect-approval"]) {
        if (flags[flag] !== undefined && typeof flags[flag] !== "string") throw new UsageError(`--${flag} needs a value`);
      }
      if (typeof flags["expect-fingerprint"] !== "string") throw new UsageError("media needs --expect-fingerprint <fp>");
      if (flags.to !== undefined && typeof flags.to !== "string") throw new UsageError("--to needs a repo-relative path");
      if (cli.configError) throw new UsageError(`Invalid brain.config: ${cli.configError}; no changes made`);
      const request = {
        id, action: action as MediaAction, expectFingerprint: flags["expect-fingerprint"],
        ...(typeof flags.to === "string" ? { destination: flags.to } : {}),
        ...(typeof flags.pattern === "string" ? { pattern: flags.pattern } : {}),
        ...(typeof flags["ignore-adjust"] === "string" ? { ignoreAdjust: flags["ignore-adjust"] } : {}),
      };
      const configPath = cli.brain.configPath === null ? null : relative(cli.brain.root, cli.brain.configPath).split(sep).join("/");
      const ctx = { root: cli.brain.root, policy: mediaPolicy(cli.brain.config), configPath, limits: mediaReferenceLimits(resolveEnv().mediaReferenceLimits) };
      let result;
      if (flags["dry-run"] === true) result = planMediaEffect(ctx, request);
      else {
        if (typeof flags["expect-premise"] !== "string" || typeof flags.journal !== "string") {
          throw new UsageError("Preview with --dry-run first, then apply with --expect-premise <premiseDigest> --journal <id>");
        }
        result = applyMediaEffect(ctx, {
          ...request, expectPremise: flags["expect-premise"], journal: flags.journal,
          ...(typeof flags["expect-approval"] === "string" ? { expectApproval: flags["expect-approval"] } : {}),
        });
      }
      emit(cli.json, result, () => console.log(JSON.stringify(result, null, 2)));
      return ["preview", "applied"].includes(result.status) ? 0 : 1;
    }

    if (sub === "list") {
      const state = flags.state;
      if (state !== undefined && !STATES.includes(state as HygieneState)) {
        throw new UsageError("--state must be open, snoozed, dismissed, resolved or kept");
      }
      const entries = readHygieneLog(cli.brain.root).filter((e) => state === undefined || e.state === state);
      emit(cli.json, { entries }, () => {
        if (entries.length === 0) console.log("No hygiene entries.");
        for (const e of entries) console.log(`${e.state.padEnd(8)} ${e.id}${e.path ? `  ${e.path}` : ""}`);
      });
      return 0;
    }

    if (sub === "unkeep") {
      const id = pos[1], journal = flags.journal;
      if (!id || pos.length !== 2) throw new UsageError("Usage: brain hygiene unkeep <id> --journal <id>");
      if (typeof journal !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(journal)) throw new UsageError("--journal needs the Keep a permanent copy journal ID");
      try {
        const { result } = await detectAndReconcile(cli, { now: new Date(), unkeep: { id, journal } });
        emit(cli.json, { status: "unkept", id, journal, changedFiles: result.changedFiles }, () => {
          console.log(`unkept ${id}`);
          for (const f of result.changedFiles) console.log(`  wrote ${f}`);
        });
        return 0;
      } catch (e) {
        if (!(e instanceof HygieneRefusal)) throw e;
        emit(cli.json, { status: "refused", reason: e.reason, id, journal }, () => console.error(e.message));
        return 1;
      }
    }

    if (sub === "dismiss" || sub === "snooze" || sub === "keep-copy") {
      const now = new Date();
      const request = dispositionRequest(sub, pos, flags, now);
      if (flags.extra === true) throw new UsageError("--extra needs a file");
      // A finding the skill reported (`--extra`) is detected again only from the same candidates.
      const extra = typeof flags.extra === "string" ? readExtra(flags.extra) : [];
      try {
        const { result } = await detectAndReconcile(cli, { now, extra, dispositions: [request] });
        const payload = {
          status: request.kind,
          id: request.id,
          fingerprint: request.expectFingerprint,
          until: request.kind === "snoozed" ? request.until : null,
          reason: request.reason?.replace(/\s+/g, " ").trim() || null,
          changedFiles: result.changedFiles,
          ...(request.kind === "kept" ? { copy: request.copy, copySha256: request.copySha256, journal: request.journal } : {}),
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

    if (sub !== "reconcile") throw new UsageError("Usage: brain hygiene <reconcile|list|next|dismiss|snooze|keep-copy|unkeep|media|resolve|undo|check>");
    if (flags.extra === true) throw new UsageError("--extra needs a file");
    if (flags.fixed === true) throw new UsageError("--fixed needs a file");
    const extra = typeof flags.extra === "string" ? readExtra(flags.extra) : [];
    const fixed = typeof flags.fixed === "string" ? readFixed(flags.fixed) : [];
    const dryRun = flags["dry-run"] === true;
    const { result } = await detectAndReconcile(cli, { now: new Date(), dryRun, extra, fixed });
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
