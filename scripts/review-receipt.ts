/**
 * The machine-readable record of an independent review (#4110). A pull request
 * whose diff touches the core packages (`scripts/fast-lane.ts`) carries it as
 * one comment, and `scripts/integrate.ts` refuses to confirm or merge such a
 * candidate without a record that covers its head.
 *
 *   bun scripts/review-receipt.ts post <pr> --reviewer agent|human --head <reviewed-sha>
 *       (--no-findings | --findings <file>) [--base <sha>] [--dry-run]
 *   bun scripts/review-receipt.ts check <pr>
 *
 * `post` writes the record and posts it; `--findings` names a JSON array of
 * `{ "summary": "..." }` entries, each answered with exactly one disposition:
 * `"disposition": "fixed"` with `"commit"`, `"filed"` with `"issue"`
 * (`owner/repo#N`) or `"rejected"` with `"reason"`. `check` prints the merge
 * path's decision for the pull request's live head without changing anything.
 * The record names the reviewer only as `agent` or `human`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanText } from "./check-leakage";
import { CORE_PACKAGES, touchesCorePackages } from "./fast-lane";
import { DEFAULT_REPO, type Gh } from "./issue-queue";

export const REVIEW_KIND = "brain-review-receipt";
export const REVIEW_START = "<!-- brain-review-receipt:start -->";
export const REVIEW_END = "<!-- brain-review-receipt:end -->";
export const REVIEWERS = ["agent", "human"] as const;
export type Reviewer = typeof REVIEWERS[number];

export type ReviewFinding =
  | { summary: string }
  | { summary: string; disposition: "fixed"; commit: string }
  | { summary: string; disposition: "filed"; issue: string }
  | { summary: string; disposition: "rejected"; reason: string };
export interface ReviewRecord {
  version: 1; kind: typeof REVIEW_KIND; pr: number; head: string; base: string; reviewer: Reviewer;
  outcome: "no-findings" | "findings"; findings: ReviewFinding[];
}
/** The exact candidate the merge path is deciding: its PR, head and live base. */
export interface ReviewCandidate { pr: number; head: string; base: string }

const SHA = /^[a-f0-9]{40}$/;
const ISSUE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/;
const RECORD_KEYS = ["version", "kind", "pr", "head", "base", "reviewer", "outcome", "findings"];
/** The second key each disposition requires, beside `summary` and `disposition`. */
const DETAIL = { fixed: "commit", filed: "issue", rejected: "reason" } as const;

/** Exactly these keys: an unknown field (a reviewer's name, a model, a session) refuses. */
const exact = (value: object, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const sha = (value: unknown): value is string => typeof value === "string" && SHA.test(value);
/** One line of prose: no line breaks or control characters, at most 500 characters. */
const prose = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 500 && !/[\u0000-\u001f\u007f]/.test(value);

function parseFinding(value: unknown): ReviewFinding {
  const finding = value as Record<string, unknown>;
  if (!finding || typeof finding !== "object" || Array.isArray(finding) || !prose(finding.summary)) throw new Error("Invalid review finding");
  if (exact(finding, ["summary"])) return finding as ReviewFinding;
  const detail = Object.hasOwn(DETAIL, String(finding.disposition)) ? DETAIL[finding.disposition as keyof typeof DETAIL] : undefined;
  if (!detail || !exact(finding, ["summary", "disposition", detail])) throw new Error("Invalid review finding: a disposition is fixed with a commit, filed with an issue or rejected with a reason, and nothing else");
  const answer = finding[detail];
  if (detail === "commit" ? !sha(answer) : detail === "issue" ? !(typeof answer === "string" && ISSUE.test(answer)) : !prose(answer)) throw new Error(`Invalid review finding ${detail}`);
  return finding as ReviewFinding;
}

export function parseReview(value: unknown): ReviewRecord {
  const r = value as ReviewRecord;
  if (!r || typeof r !== "object" || Array.isArray(r) || !exact(r, RECORD_KEYS) || r.version !== 1 || r.kind !== REVIEW_KIND ||
      !Number.isSafeInteger(r.pr) || r.pr < 1 || !sha(r.head) || !sha(r.base) || !REVIEWERS.includes(r.reviewer) ||
      !Array.isArray(r.findings) || r.findings.length > 100) throw new Error("Invalid review record");
  // A review with no findings says so; an empty list never stands in for it.
  if (r.outcome !== (r.findings.length ? "findings" : "no-findings")) throw new Error("Invalid review record: the outcome is no-findings exactly when the findings list is empty");
  r.findings.forEach(parseFinding);
  return r;
}

export const undisposed = (record: ReviewRecord) => record.findings.filter(finding => !("disposition" in finding));

/** The fixed block the comment carries; the merge path reads nothing else. */
export function reviewBlock(record: ReviewRecord): string {
  return [REVIEW_START, "```json", JSON.stringify(record), "```", REVIEW_END].join("\n");
}

/** The whole comment: the same facts as prose for a reader, then the block. */
export function reviewComment(record: ReviewRecord): string {
  const line = (finding: ReviewFinding) => !("disposition" in finding) ? `**no disposition yet**: ${finding.summary}`
    : finding.disposition === "fixed" ? `**fixed** in ${finding.commit}: ${finding.summary}`
    : finding.disposition === "filed" ? `**filed** as ${finding.issue}: ${finding.summary}`
    : `**rejected**: ${finding.summary} Reason: ${finding.reason}`;
  return ["## Independent review", "",
    `Reviewed head ${record.head} against base ${record.base}. Reviewer: ${record.reviewer}.`, "",
    record.findings.length ? record.findings.map((finding, index) => `${index + 1}. ${line(finding)}`).join("\n") : "No findings.", "",
    reviewBlock(record)].join("\n");
}

/** The record one comment carries: null when it has no block; an unreadable or doubled block refuses. */
export function reviewFromBody(body: string | null | undefined): ReviewRecord | null {
  const text = (body ?? "").replace(/\r\n/g, "\n");
  const blocks: string[] = [];
  let at = 0;
  for (;;) {
    const start = text.indexOf(REVIEW_START, at);
    if (start < 0) break;
    const end = text.indexOf(REVIEW_END, start);
    if (end < 0) throw new Error("Unterminated review record block");
    blocks.push(text.slice(start + REVIEW_START.length, end)); at = end + REVIEW_END.length;
  }
  if (!blocks.length) return null;
  if (blocks.length > 1) throw new Error("One comment carries more than one review record");
  const json = /```json\s*\n([\s\S]*?)\n\s*```/.exec(blocks[0]!)?.[1]?.trim();
  if (!json) throw new Error("The review record block is empty");
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw new Error("The review record is not JSON"); }
  return parseReview(parsed);
}

/**
 * The newest record among a pull request's comments, given oldest first. Only
 * the newest counts: an unreadable newest record refuses and never falls back
 * to an older one.
 */
export function newestReview(comments: readonly (string | null | undefined)[]): ReviewRecord | null {
  for (let index = comments.length - 1; index >= 0; index--) {
    if ((comments[index] ?? "").includes(REVIEW_START)) return reviewFromBody(comments[index]);
  }
  return null;
}

function git(root: string, args: string[]): { code: number; out: string; err: string } {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode ?? 1, out: new TextDecoder().decode(result.stdout), err: new TextDecoder().decode(result.stderr).trim() };
}
function must(root: string, args: string[]): string {
  const result = git(root, args);
  if (result.code !== 0) throw new Error(`git ${args.slice(0, 2).join(" ")} failed: ${result.err}`);
  return result.out;
}
/** A commit this repository has, fetching it on demand; false when it can be neither read nor fetched. */
function available(root: string, commit: string): boolean {
  const present = () => git(root, ["cat-file", "-e", `${commit}^{commit}`]).code === 0;
  return present() || (git(root, ["fetch", "--no-tags", "origin", commit]).code === 0 && present());
}

/** Paths the candidate changes against its merge base, with a rename counted at both ends. */
export function changedPaths(root: string, candidate: ReviewCandidate): string[] {
  for (const commit of [candidate.base, candidate.head]) if (!available(root, commit)) throw new Error(`Cannot read candidate commit ${commit}`);
  return must(root, ["diff", "--name-only", "--no-renames", "-z", `${candidate.base}...${candidate.head}`]).split("\0").filter(Boolean);
}

/**
 * Non-merge commits in the candidate head that neither the base nor the
 * reviewed head contains: the work nobody reviewed. Merging the base into the
 * branch adds only a merge commit and commits the base already has, so a
 * refresh by merge leaves this empty; a rebase or an amend rewrites the
 * reviewed commits and does not.
 */
export function unreviewedCommits(root: string, candidate: ReviewCandidate, reviewedHead: string): string[] {
  return must(root, ["rev-list", "--no-merges", candidate.head, `^${candidate.base}`, `^${reviewedHead}`]).split("\n").filter(Boolean);
}

const REMEDY = "Have a fresh agent context or a human review it, given only the pull request and its issue, then record the result with";

/**
 * The merge decision for a core-package candidate's review; returns the
 * refusal text or null. `comments` are the pull request's comment bodies,
 * oldest first.
 */
export function reviewRefusal(root: string, candidate: ReviewCandidate, comments: readonly (string | null | undefined)[]): string | null {
  const post = `\`bun scripts/review-receipt.ts post ${candidate.pr} --reviewer <agent|human> --head <reviewed-sha> (--no-findings | --findings <file>)\``;
  const record = newestReview(comments);
  if (!record) return `No review record on PR #${candidate.pr}, whose diff touches the core packages (${CORE_PACKAGES.map(name => `packages/${name}/`).join(", ")}). ${REMEDY} ${post}`;
  if (record.pr !== candidate.pr) return `The newest review record on PR #${candidate.pr} names PR #${record.pr}. ${REMEDY} ${post}`;
  const open = undisposed(record);
  if (open.length) return `The newest review record (head ${record.head}) leaves ${open.length} finding${open.length === 1 ? "" : "s"} without a disposition: ${open.map(finding => JSON.stringify(finding.summary)).join("; ")}. Answer each as fixed (naming the commit), filed (naming the issue) or rejected (with the reason), and post the record again with ${post}`;
  for (const finding of record.findings) {
    if ("disposition" in finding && finding.disposition === "fixed" && !(available(root, finding.commit) && git(root, ["merge-base", "--is-ancestor", finding.commit, candidate.head]).code === 0)) {
      return `The newest review record answers a finding as fixed in ${finding.commit}, which the candidate head ${candidate.head} does not contain. Name the commit that fixes it and post the record again with ${post}`;
    }
  }
  if (!available(root, record.head)) return `The reviewed head ${record.head} can be neither read nor fetched, so the commits added since cannot be established. ${REMEDY} ${post}`;
  const fresh = unreviewedCommits(root, candidate, record.head);
  if (!fresh.length) return null;
  return `The candidate head ${candidate.head} contains ${fresh.length} commit${fresh.length === 1 ? "" : "s"} the reviewed head ${record.head} does not (${fresh.slice(0, 5).map(commit => commit.slice(0, 12)).join(", ")}${fresh.length > 5 ? ", ..." : ""}). Merging the base keeps a record valid; a new commit, a rebase or an amend needs a new review of the current head. ${REMEDY} ${post}`;
}

/**
 * The whole gate: a candidate outside the core packages is never asked for a
 * review, and its comments are never read.
 */
export async function reviewGate(root: string, candidate: ReviewCandidate, comments: () => Promise<readonly (string | null | undefined)[]>): Promise<string | null> {
  if (!touchesCorePackages(changedPaths(root, candidate))) return null;
  return reviewRefusal(root, candidate, await comments());
}

export interface ReviewIo { gh?: Gh; out: (text: string) => void; root?: string }

const realGh: Gh = args => {
  const result = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
};
function ghMust(gh: Gh, args: string[]): string {
  const result = gh(args);
  if (result.code !== 0) throw new Error(`gh ${args.slice(0, 3).join(" ")}: ${result.stderr.trim() || `exit ${result.code}`}`);
  return result.stdout;
}

/** Comment bodies of one pull request, oldest first: GitHub lists issue comments by ascending id. */
export function commentBodies(gh: Gh, repo: string, pr: number): string[] {
  return ghMust(gh, ["api", `repos/${repo}/issues/${pr}/comments`, "--paginate", "--jq", ".[] | .body | @json"])
    .split("\n").filter(Boolean).map(line => String(JSON.parse(line) ?? ""));
}

const USAGE = "usage: bun scripts/review-receipt.ts post <pr> --reviewer agent|human --head <reviewed-sha> (--no-findings | --findings <file>) [--base <sha>] [--dry-run] | check <pr>";

export async function main(argv: readonly string[], io: ReviewIo): Promise<number> {
  const gh = io.gh ?? realGh, root = io.root ?? process.cwd();
  const flags = new Map<string, string | true>(), positional: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) positional.push(arg);
    else if (flags.has(arg.slice(2))) throw new Error(`${arg} given twice`);
    else if (["no-findings", "dry-run"].includes(arg.slice(2))) flags.set(arg.slice(2), true);
    else if (["reviewer", "head", "base", "findings", "repo"].includes(arg.slice(2))) { const value = argv[++index]; if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`); flags.set(arg.slice(2), value); }
    else throw new Error(`Unknown option ${arg}`);
  }
  const text = (name: string) => { const value = flags.get(name); return typeof value === "string" ? value : undefined; };
  const [command, target] = positional;
  if (!["post", "check"].includes(command ?? "") || !/^[1-9]\d*$/.test(target ?? "") || positional.length !== 2) { io.out(USAGE); return 2; }
  const pr = Number(target), repo = text("repo") ?? DEFAULT_REPO;
  const live = JSON.parse(ghMust(gh, ["api", `repos/${repo}/pulls/${pr}`])) as { state: string; head: { sha: string }; base: { ref: string; sha: string } };

  if (command === "check") {
    const base = ghMust(gh, ["api", `repos/${repo}/git/ref/heads/${live.base.ref}`, "--jq", ".object.sha"]).trim();
    const candidate = { pr, head: live.head.sha, base };
    const required = touchesCorePackages(changedPaths(root, candidate));
    const comments = required ? commentBodies(gh, repo, pr) : [];
    const refusal = required ? reviewRefusal(root, candidate, comments) : null, record = newestReview(comments);
    io.out(JSON.stringify({ ...candidate, required, record: record && { head: record.head, reviewer: record.reviewer, findings: record.findings.length, undisposed: undisposed(record).length }, refusal }));
    return refusal ? 1 : 0;
  }

  if (live.state !== "open") throw new Error(`PR #${pr} is ${live.state}; a review is recorded on an open pull request`);
  if (!REVIEWERS.includes(text("reviewer") as Reviewer)) throw new Error("--reviewer is agent or human; the record names no other identity");
  if (!sha(text("head"))) throw new Error("--head needs the full reviewed commit SHA: the head the reviewer read");
  if (flags.has("no-findings") === flags.has("findings")) throw new Error("Give exactly one of --no-findings and --findings <file>: a review with no findings says so");
  const findings: unknown = flags.has("findings") ? JSON.parse(readFileSync(text("findings")!, "utf8")) : [];
  if (!Array.isArray(findings) || (flags.has("findings") && !findings.length)) throw new Error("--findings needs a JSON array with at least one finding; use --no-findings for a review that found nothing");
  const record = parseReview({ version: 1, kind: REVIEW_KIND, pr, head: text("head"), base: text("base") ?? live.base.sha, reviewer: text("reviewer"),
    outcome: findings.length ? "findings" : "no-findings", findings });
  const body = reviewComment(record);
  // Every word of the comment is public: the leakage gate reads it before anything is posted.
  if (scanText("review record", body).length) throw new Error("The review record contains text the leakage gate refuses; nothing was posted");
  if (flags.has("dry-run")) { io.out(body); return 0; }
  const dir = mkdtempSync(join(tmpdir(), "review-receipt-"));
  try {
    writeFileSync(join(dir, "body.md"), body);
    ghMust(gh, ["pr", "comment", String(pr), "--repo", repo, "--body-file", join(dir, "body.md")]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  io.out(JSON.stringify({ posted: true, pr, head: record.head, base: record.base, reviewer: record.reviewer, findings: record.findings.length, undisposed: undisposed(record).length }));
  return 0;
}

if (import.meta.main) {
  try { process.exit(await main(process.argv.slice(2), { out: text => console.log(text) })); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(2); }
}
