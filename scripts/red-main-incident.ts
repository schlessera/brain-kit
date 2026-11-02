/**
 * Red-main incident workflow (#2944): one orchestrator claims the fix, every
 * orchestrator adds evidence to the one incident issue the coordinator filed.
 *
 *   bun scripts/red-main-incident.ts claim    --worker <id> --orchestrator <id>
 *   bun scripts/red-main-incident.ts renew    --worker <id> --orchestrator <id>
 *   bun scripts/red-main-incident.ts release  --worker <id> --orchestrator <id>
 *   bun scripts/red-main-incident.ts evidence --worker <id> --orchestrator <id> --kind <kind> --summary <line>
 *        [--sha <sha>] [--issue <n>] [--details-file <path>] [--choice fix|revert|uncertain]
 *
 * Add `--dry-run` to print every write instead of sending it, and
 * `--record <file> --repository <owner/repo>` to replay against a fixture record
 * with no GitHub or Git access at all.
 *
 * The claim is written into the red-main record through the coordination ref's
 * compare-and-swap, then mirrored to the issue's assignment and a claim comment.
 * Nothing here opens an incident issue: that is the coordinator's job alone.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { scanText } from "./check-leakage";
import { GitReservationStore, reservationServerTime } from "./integration-reservation";
import { claimFix, liveClaim, parseRedMain, releaseFixClaim, renewFixClaim, type Claimant, type FixClaim, type RedIncident, type RedMainRecord } from "./red-main";
import { updateRecord, type Snapshot } from "./red-main-coordinator";

export interface IncidentIO {
  repository: string;
  /** GitHub login the claim is mirrored to as an assignee. */
  login: string;
  read(): Snapshot;
  publish(snapshot: Snapshot, record: RedMainRecord): boolean;
  /** Authoritative GitHub server time. */
  now(): Promise<number>;
  json(path: string): Promise<any>;
  write(method: "POST" | "DELETE", path: string, body?: unknown): Promise<any>;
}

export const EVIDENCE_KINDS = ["reproduction", "bisect", "log", "ruled-out", "related", "duplicate", "fix-attempt", "decision"] as const;
/** The claimant's recovery choice (#2934 ruling, 2026-11-02): a fix PR, a targeted revert PR, or explicit uncertainty. */
export const CHOICES = ["fix", "revert", "uncertain"] as const;
export type Choice = typeof CHOICES[number];
export type EvidenceKind = typeof EVIDENCE_KINDS[number];
export interface Evidence extends Claimant { kind: EvidenceKind; summary: string; sha?: string; issue?: number; details?: string; choice?: Choice; }

export const claimMarker = (run: number, claim: FixClaim) => `<!-- brain-red-main-claim: run ${run} claimed ${claim.claimed} -->`;
export const releaseMarker = (run: number, claim: FixClaim) => `<!-- brain-red-main-release: run ${run} claimed ${claim.claimed} -->`;
export const evidenceMarker = (run: number, kind: EvidenceKind) => `<!-- brain-red-main-evidence: run ${run} kind ${kind} -->`;
const iso = (ms: number) => new Date(ms).toISOString();
const short = (sha: string) => sha.slice(0, 12);
const issuePath = (io: IncidentIO, n: number) => `repos/${io.repository}/issues/${n}`;

export function claimComment(open: RedIncident, claim: FixClaim): string {
  const lines = [claimMarker(open.run, claim)];
  if (claim.takeover) lines.push(`**Fix claim takeover**: worker \`${claim.worker}\` (orchestrator \`${claim.orchestrator}\`) took over the fix from worker \`${claim.takeover.worker}\` (orchestrator \`${claim.takeover.orchestrator}\`), whose claim expired at ${iso(claim.takeover.expired)}.`);
  else lines.push(`**Fix claimed** by worker \`${claim.worker}\` (orchestrator \`${claim.orchestrator}\`).`);
  lines.push("", `- Main red at \`${short(open.firstBad)}\` (record run ${open.run}).`, `- Claim term ends ${iso(claim.expires)}; the claimant renews it with \`bun scripts/red-main-incident.ts renew\`. After it ends, any orchestrator may take the fix over with \`claim\`.`,
    "- Everyone else: add evidence here with `bun scripts/red-main-incident.ts evidence`; do not open another incident.");
  return lines.join("\n");
}

/** Fenced so any backtick run inside the details stays literal. */
function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(m => m[0].length));
  const bar = "`".repeat(longest + 1);
  return `${bar}text\n${text.replace(/\s+$/, "")}\n${bar}`;
}

/** The fixed evidence format: a marker, a heading naming the kind, then fixed fields in a fixed order. */
export function formatEvidence(open: RedIncident, evidence: Evidence, role: "claimant" | "contributor"): string {
  const lines = [evidenceMarker(open.run, evidence.kind), `### Red-main evidence: ${evidence.kind}`, "",
    `- **Incident:** main red at \`${short(open.firstBad)}\` (record run ${open.run})`,
    `- **From:** worker \`${evidence.worker}\`, orchestrator \`${evidence.orchestrator}\` (${role})`];
  if (evidence.sha) lines.push(`- **SHA:** \`${evidence.sha}\``);
  if (evidence.choice) lines.push(`- **Choice:** ${evidence.choice === "fix" ? "fix PR" : evidence.choice === "revert" ? "targeted revert PR" : "uncertain: neither a fix nor a revert is supportable yet"}`);
  if (evidence.issue) lines.push(`- **${evidence.kind === "duplicate" ? "Duplicate" : "Related"} issue:** #${evidence.issue}`);
  lines.push(`- **Summary:** ${evidence.summary}`);
  if (evidence.details?.trim()) lines.push("", fence(evidence.details));
  return lines.join("\n");
}

function validateEvidence(evidence: Evidence): void {
  if (!EVIDENCE_KINDS.includes(evidence.kind)) throw new Error(`Evidence kind must be one of ${EVIDENCE_KINDS.join(", ")}`);
  if (!evidence.summary.trim() || evidence.summary.length > 300 || /[\r\n]/.test(evidence.summary)) throw new Error("Evidence needs a one-line summary of at most 300 characters");
  if (evidence.sha !== undefined && !/^[a-f0-9]{7,40}$/.test(evidence.sha)) throw new Error("Invalid evidence SHA");
  if (evidence.issue !== undefined && !(Number.isSafeInteger(evidence.issue) && evidence.issue > 0)) throw new Error("Invalid related issue number");
  if ((evidence.kind === "related" || evidence.kind === "duplicate") !== (evidence.issue !== undefined)) throw new Error("--issue is required for, and only for, related and duplicate evidence");
  if ((evidence.kind === "decision") !== (evidence.choice !== undefined)) throw new Error("--choice is required for, and only for, decision evidence");
  if (evidence.choice !== undefined && !CHOICES.includes(evidence.choice)) throw new Error(`--choice must be one of ${CHOICES.join(", ")}`);
  if (evidence.kind === "decision" && !evidence.details?.trim()) throw new Error("Decision evidence needs --details-file with the causal and current-tree rationale");
  if ((evidence.details?.length ?? 0) > 20_000) throw new Error("Evidence details are limited to 20000 characters; link a run or artifact instead");
}

function publicText(name: string, text: string): string {
  if (scanText(name, text).length) throw new Error(`The ${name} failed the leakage gate; remove personal data before posting`);
  return text;
}

/** Whether a comment carrying this marker already exists, so a rerun after a crash mirrors once. */
async function hasComment(io: IncidentIO, incident: number, marker: string, since: number): Promise<boolean> {
  const comments = await io.json(`${issuePath(io, incident)}/comments?since=${encodeURIComponent(iso(since))}&per_page=100`);
  return Array.isArray(comments) && comments.some((comment: { body?: string }) => comment.body?.includes(marker));
}

export type ClaimMode = "claim" | "renew" | "release";
export interface ClaimResult { mode: ClaimMode; incident: number; claim: FixClaim | null; action: string | undefined; mirrored: string[]; }

/** Writes the claim through the record's compare-and-swap first; the issue only mirrors what won. */
export async function claimIncident(io: IncidentIO, who: Claimant, mode: ClaimMode): Promise<ClaimResult> {
  const transition = mode === "claim" ? claimFix : mode === "renew" ? renewFixClaim : releaseFixClaim;
  const { before, after } = await updateRecord(io, (record, now) => transition(record, who, now));
  const open = after.open!, incident = open.incident!, mirrored: string[] = [];
  if (mode === "claim") {
    const claim = open.claim!;
    await io.write("POST", `${issuePath(io, incident)}/assignees`, { assignees: [io.login] });
    mirrored.push("assignee");
    if (!await hasComment(io, incident, claimMarker(open.run, claim), claim.claimed)) {
      await io.write("POST", `${issuePath(io, incident)}/comments`, { body: publicText("claim comment", claimComment(open, claim)) });
      mirrored.push(claim.takeover ? "takeover-comment" : "claim-comment");
    }
  } else if (mode === "release") {
    const held = before.open!.claim!;
    await io.write("POST", `${issuePath(io, incident)}/comments`, { body: [releaseMarker(open.run, held),
      `**Fix claim released** by worker \`${held.worker}\` (orchestrator \`${held.orchestrator}\`). Any orchestrator may claim the fix with \`bun scripts/red-main-incident.ts claim\`.`].join("\n") });
    await io.write("DELETE", `${issuePath(io, incident)}/assignees`, { assignees: [io.login] });
    mirrored.push("release-comment", "assignee-removed");
  }
  return { mode, incident, claim: open.claim ?? null, action: after.last?.action, mirrored };
}

/** Appends one evidence comment to the record's incident; it never files an issue and never writes the record. */
export async function postEvidence(io: IncidentIO, evidence: Evidence): Promise<{ incident: number; role: "claimant" | "contributor"; body: string }> {
  validateEvidence(evidence);
  const open = io.read().redMain.open;
  if (!open) throw new Error("Main is not red; there is no incident to add evidence to");
  if (open.incident === null) throw new Error("Incident pending: the coordinator has not filed the incident issue yet; retry when main-status names it");
  const now = await io.now(), claim = open.claim ?? null;
  const role = claim && liveClaim(claim, now) && claim.worker === evidence.worker && claim.orchestrator === evidence.orchestrator ? "claimant" : "contributor";
  const body = publicText("evidence comment", formatEvidence(open, evidence, role));
  await io.write("POST", `${issuePath(io, open.incident)}/comments`, { body });
  if (evidence.kind === "duplicate") await io.write("POST", `${issuePath(io, evidence.issue!)}/comments`, {
    body: publicText("duplicate note", `This failure is tracked by red-main incident #${open.incident} (main red at \`${short(open.firstBad)}\`). Please add evidence there.`) });
  return { incident: open.incident, role, body };
}

export function parseArgs(argv: string[]): { command: string; flags: Map<string, string>; dryRun: boolean } {
  const [command = "", ...rest] = argv, flags = new Map<string, string>();
  let dryRun = false;
  const known = ["--worker", "--orchestrator", "--kind", "--summary", "--sha", "--issue", "--details-file", "--choice", "--record", "--repository", "--now"];
  for (let index = 0; index < rest.length; index++) {
    const key = rest[index]!;
    if (key === "--dry-run") { dryRun = true; continue; }
    const value = rest[++index];
    if (!known.includes(key) || value === undefined || value.startsWith("--") || flags.has(key)) throw new Error(`Invalid option ${key}`);
    flags.set(key, value);
  }
  if ((flags.has("--record") || flags.has("--now")) && !dryRun) throw new Error("--record and --now only replay a fixture with --dry-run");
  return { command, flags, dryRun };
}

async function gh(args: string[], input?: string): Promise<string> {
  const child = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe", stdin: input === undefined ? "ignore" : new TextEncoder().encode(input) });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${err.trim()}`);
  return out.trim();
}

async function liveIO(): Promise<IncidentIO> {
  const repository = await gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  const store = new GitReservationStore(process.cwd());
  const remote = store.git(["remote", "get-url", "origin"]).replace(/^git@github.com:/, "https://github.com/").replace(/\.git$/, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || remote !== `https://github.com/${repository}`) throw new Error("Authenticated repository and origin differ");
  return {
    repository, login: await gh(["api", "user", "--jq", ".login"]),
    read: () => store.read(),
    publish: (snapshot, record) => store.publishRedMain(snapshot as Parameters<GitReservationStore["publishRedMain"]>[0], record),
    async now() { return reservationServerTime(await gh(["api", "--include", "-H", "Cache-Control: no-cache", `repos/${repository}/git/ref/heads/main?red_main_clock=${randomUUID()}`])); },
    async json(path) { return JSON.parse(await gh(["api", path])); },
    async write(method, path, body) {
      const out = await gh(["api", "-X", method, path, ...(body === undefined ? [] : ["--input", "-"])], body === undefined ? undefined : JSON.stringify(body));
      return out ? JSON.parse(out) : {};
    },
  };
}

/** Dry runs read for real (or from a fixture record) and print every write instead of sending it. */
function dryRunIO(base: IncidentIO | null, flags: Map<string, string>, print: (line: string) => void): IncidentIO {
  const fixture = flags.get("--record");
  let snapshot: Snapshot = fixture ? { oid: "fixture", redMain: parseRedMain(readFileSync(fixture, "utf8")) } : base!.read();
  const repository = flags.get("--repository") ?? base?.repository ?? "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("A fixture dry run needs --repository <owner/repo>");
  const fixedNow = flags.has("--now") ? Date.parse(flags.get("--now")!) : NaN;
  if (flags.has("--now") && !Number.isFinite(fixedNow)) throw new Error("Invalid --now");
  return {
    repository, login: base?.login ?? "fixture-login",
    read: () => snapshot,
    publish(_seen, record) { snapshot = { oid: `${snapshot.oid}+1`, redMain: record }; print(`DRY_RUN record ${JSON.stringify(record)}`); return true; },
    now: async () => Number.isFinite(fixedNow) ? fixedNow : base ? base.now() : Date.now(),
    json: async path => base ? base.json(path) : [],
    async write(method, path, body) { print(`DRY_RUN ${method} ${path} ${JSON.stringify(body ?? null)}`); return {}; },
  };
}

export async function main(argv: string[], print: (line: string) => void = console.log): Promise<void> {
  const { command, flags, dryRun } = parseArgs(argv);
  const usage = "usage: bun scripts/red-main-incident.ts claim|renew|release|evidence --worker <id> --orchestrator <id> [--kind <kind> --summary <line> [--sha <sha>] [--issue <n>] [--details-file <path>] [--choice fix|revert|uncertain]] [--dry-run [--record <file> --repository <owner/repo> --now <iso>]]";
  if (!["claim", "renew", "release", "evidence"].includes(command)) throw new Error(usage);
  const who = { worker: flags.get("--worker") ?? "", orchestrator: flags.get("--orchestrator") ?? "" };
  if (!who.worker || !who.orchestrator) throw new Error(usage);
  const base = flags.has("--record") ? null : await liveIO();
  const io = dryRun ? dryRunIO(base, flags, print) : base!;
  if (command === "evidence") {
    const issue = flags.get("--issue"), file = flags.get("--details-file");
    if (issue !== undefined && !/^[1-9]\d*$/.test(issue)) throw new Error("Invalid related issue number");
    const result = await postEvidence(io, { ...who, kind: (flags.get("--kind") ?? "") as EvidenceKind, summary: flags.get("--summary") ?? "",
      ...(flags.has("--sha") ? { sha: flags.get("--sha")! } : {}), ...(issue ? { issue: Number(issue) } : {}), ...(flags.has("--choice") ? { choice: flags.get("--choice") as Choice } : {}), ...(file ? { details: readFileSync(file, "utf8") } : {}) });
    print(JSON.stringify({ evidence: true, incident: result.incident, role: result.role, dryRun }));
  } else print(JSON.stringify({ ...await claimIncident(io, who, command as ClaimMode), dryRun }));
}

if (import.meta.main) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
}
