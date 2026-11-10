/**
 * The mechanical half of picking up and triaging issues, for the `work-issue`
 * and `triage-issues` skills: which issue is next, what one issue's state is,
 * claiming and releasing it, and changing its labels without breaking the
 * readiness rules. Each command reads GitHub through `gh`, applies the rules
 * of docs/process/github.md in code, and prints one line of JSON, so every
 * agent gets the same answer and none of them pipes `gh` through `jq`.
 *
 *   bun scripts/issue-queue.ts candidates [--limit n]    eligible agent-ready issues, in pick-up order
 *   bun scripts/issue-queue.ts snapshot                  open issues without agent-ready, for a triage pass
 *   bun scripts/issue-queue.ts show <n> [--thread file]  one issue: labels, owner, parent, blockers, open PRs
 *   bun scripts/issue-queue.ts check                     open issues whose labels contradict each other
 *   bun scripts/issue-queue.ts claim <n> --branch <name> [--note text] [--stack-reviewed]
 *   bun scripts/issue-queue.ts release <n>
 *   bun scripts/issue-queue.ts labels <n> [--add a,b] [--remove c,d] [--updated-at ts]
 *
 * Options: --repo owner/name (default schlessera/brain-kit), --pretty.
 * `claim`, `release` and `labels` write to the tracker; the rest only read.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GhResult { code: number; stdout: string; stderr: string }
/** Runs `gh` with these arguments. Tests replace it; nothing else reaches the network. */
export type Gh = (args: string[]) => GhResult;

export interface Issue {
  number: number; title: string; state: string; stateReason: string | null; createdAt: string; updatedAt: string;
  labels: string[]; assignees: string[]; milestone: string | null; isPullRequest: boolean; comments: number; body: string;
}

export const DEFAULT_REPO = "schlessera/brain-kit";
const REDUCE = "{number,title,state,state_reason,created_at,updated_at,labels:[.labels[].name],assignees:[.assignees[].login],"
  + "milestone:(.milestone.title // null),pr:(.pull_request != null),comments,body:(.body // \"\")}";

const realGh: Gh = args => {
  const result = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
};

function must(gh: Gh, args: string[]): string {
  const result = gh(args);
  if (result.code !== 0) throw new Error(`gh ${args.slice(0, 3).join(" ")}: ${result.stderr.trim() || `exit ${result.code}`}`);
  return result.stdout;
}

interface Raw { number: number; title: string; state: string; state_reason: string | null; created_at: string; updated_at: string;
  labels: string[]; assignees: string[]; milestone: string | null; pr: boolean; comments: number; body: string }
const fromRaw = (raw: Raw): Issue => ({ number: raw.number, title: raw.title, state: raw.state, stateReason: raw.state_reason,
  createdAt: raw.created_at, updatedAt: raw.updated_at, labels: raw.labels, assignees: raw.assignees, milestone: raw.milestone,
  isPullRequest: raw.pr, comments: raw.comments, body: raw.body });

/** Every open issue and pull request, all pages. */
export function listOpen(gh: Gh, repo: string, query = ""): Issue[] {
  const lines = must(gh, ["api", "--paginate", `repos/${repo}/issues?state=open&per_page=100${query}`, "--jq", `.[] | ${REDUCE} | tojson`]);
  return lines.split("\n").filter(Boolean).map(line => fromRaw(JSON.parse(line) as Raw));
}

export function readIssue(gh: Gh, repo: string, number: number): Issue {
  return fromRaw(JSON.parse(must(gh, ["api", `repos/${repo}/issues/${number}`, "--jq", `${REDUCE} | tojson`])) as Raw);
}

const isEpic = (issue: Issue): boolean => issue.labels.includes("epic") || issue.labels.includes("type: epic");
const needs = (issue: Issue): string[] => issue.labels.filter(label => label.startsWith("needs:"));
const priorities = (issue: Issue): string[] => issue.labels.filter(label => label.startsWith("priority:"));
const types = (issue: Issue): string[] => issue.labels.filter(label => label.startsWith("type:") && label !== "type: epic");

/** Why an issue cannot be picked up, or `null` when it can. `blocked` is the caller's question. */
export function ineligible(issue: Issue): string | null {
  if (issue.isPullRequest) return "is a pull request";
  if (issue.state !== "open") return `is ${issue.state}`;
  if (!issue.labels.includes("agent-ready")) return "lacks agent-ready";
  if (issue.assignees.length) return `is assigned to ${issue.assignees.length} account(s)`;
  if (isEpic(issue)) return "is an epic";
  if (needs(issue).length) return `carries ${needs(issue).join(", ")}`;
  return null;
}

export interface OpenPr { number: number; head: string; draft: boolean; body: string }

export function listOpenPrs(gh: Gh, repo: string): OpenPr[] {
  const raw = JSON.parse(must(gh, ["pr", "list", "--repo", repo, "--state", "open", "--limit", "300", "--json", "number,headRefName,isDraft,body"])) as
    Array<{ number: number; headRefName: string; isDraft: boolean; body: string }>;
  return raw.map(pr => ({ number: pr.number, head: pr.headRefName, draft: pr.isDraft, body: pr.body ?? "" }));
}

/** Open pull requests that already work on an issue: a branch carrying its number, or a body that refers to it. */
export function activeWork(issue: number, prs: readonly OpenPr[]): number[] {
  const branch = new RegExp(`(?:^|[/_-])${issue}(?:[/_-]|$)`);
  const reference = new RegExp(`\\b(?:refs|closes|close|closed|fixes|fix|fixed|resolves|resolve|resolved|part of)\\s+#${issue}\\b`, "i");
  return prs.filter(pr => branch.test(pr.head) || reference.test(pr.body)).map(pr => pr.number).sort((a, b) => a - b);
}

export interface Candidate { number: number; title: string; priority: string; createdAt: string; requiresStackReview: boolean; activeWork: number[] }

/** Eligible issues in pick-up order: priority p0 to p3, then oldest, then lowest number. */
export function candidates(issues: readonly Issue[], prs: readonly OpenPr[]): { candidates: Candidate[]; unsorted: Array<{ number: number; title: string; reason: string }> } {
  const sorted: Array<Candidate & { rank: number }> = [];
  const unsorted: Array<{ number: number; title: string; reason: string }> = [];
  for (const issue of issues) {
    if (ineligible(issue)) continue;
    const found = priorities(issue);
    if (found.length !== 1 || !/^priority: p[0-3]$/.test(found[0]!)) {
      unsorted.push({ number: issue.number, title: issue.title, reason: found.length ? `priority labels: ${found.join(", ")}` : "no priority label" });
      continue;
    }
    sorted.push({ number: issue.number, title: issue.title, priority: found[0]!, createdAt: issue.createdAt,
      requiresStackReview: issue.labels.includes("blocked"), activeWork: activeWork(issue.number, prs), rank: Number(found[0]!.slice(-1)) });
  }
  sorted.sort((a, b) => a.rank - b.rank || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) || a.number - b.number);
  return { candidates: sorted.map(({ rank: _rank, ...rest }) => rest), unsorted: unsorted.sort((a, b) => a.number - b.number) };
}

/** Label combinations the tracker's rules forbid. An empty list means the labels are consistent. */
export function labelProblems(issue: Pick<Issue, "labels">, known?: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const subject = issue as Issue;
  if (known) for (const label of issue.labels) if (!known.has(label)) problems.push(`unknown label "${label}"`);
  if (types(subject).length > 1) problems.push(`more than one type: ${types(subject).join(", ")}`);
  if (priorities(subject).length > 1) problems.push(`more than one priority: ${priorities(subject).join(", ")}`);
  if (issue.labels.includes("agent-ready")) {
    if (isEpic(subject)) problems.push("an epic never carries agent-ready");
    if (needs(subject).length) problems.push(`agent-ready with ${needs(subject).join(", ")}`);
  }
  return problems;
}

/** What a triage pass still owes an issue, beyond contradictions. */
export function labelGaps(issue: Issue): string[] {
  const gaps: string[] = [];
  if (!isEpic(issue) && types(issue).length === 0) gaps.push("no type");
  if (!issue.labels.some(label => label.startsWith("area:"))) gaps.push("no area");
  if (priorities(issue).length === 0) gaps.push("no priority");
  return gaps;
}

function parseFlags(argv: readonly string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = [], flags = new Map<string, string | true>();
  const boolean = new Set(["pretty", "stack-reviewed", "help"]);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const [name, inline] = arg.slice(2).split(/=(.*)/s) as [string, string | undefined];
    if (boolean.has(name)) { flags.set(name, true); continue; }
    const value = inline ?? argv[++index];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    flags.set(name, value);
  }
  return { positional, flags };
}

export interface QueueIo { gh?: Gh; out: (text: string) => void; token?: () => string }

export async function main(argv: readonly string[], io: QueueIo): Promise<number> {
  const { positional, flags } = parseFlags(argv);
  const gh = io.gh ?? realGh;
  const text = (name: string) => { const value = flags.get(name); return typeof value === "string" ? value : undefined; };
  const repo = text("repo") ?? DEFAULT_REPO;
  const print = (value: unknown) => io.out(JSON.stringify(value, null, flags.has("pretty") ? 2 : undefined));
  const [command, target] = positional;
  const number = () => {
    if (!/^[1-9]\d*$/.test(target ?? "")) throw new Error(`${command} needs an issue number`);
    return Number(target);
  };
  const list = (value: string | undefined) => (value ?? "").split(",").map(label => label.trim()).filter(Boolean);
  const comment = async (issue: number, body: string) => {
    const { scanText } = await import("./check-leakage");
    const findings = scanText("tracker comment", body);
    if (findings.length) throw new Error("The comment contains text the leakage gate refuses; nothing was posted");
    const dir = mkdtempSync(join(tmpdir(), "issue-queue-"));
    try {
      writeFileSync(join(dir, "body.md"), body);
      must(gh, ["issue", "comment", String(issue), "--repo", repo, "--body-file", join(dir, "body.md")]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  if (command === "candidates") {
    const found = candidates(listOpen(gh, repo, "&labels=agent-ready"), listOpenPrs(gh, repo));
    const limit = Number(text("limit") ?? 10);
    print({ repo, eligible: found.candidates.length, candidates: found.candidates.slice(0, limit), unsorted: found.unsorted });
  } else if (command === "snapshot") {
    const rows = listOpen(gh, repo).filter(issue => !issue.isPullRequest && !issue.labels.includes("agent-ready")).sort((a, b) => a.number - b.number);
    print({ repo, count: rows.length, issues: rows.map(issue => ({ number: issue.number, title: issue.title, updatedAt: issue.updatedAt, labels: issue.labels,
      ...(issue.assignees.length ? { assigned: true } : {}) })) });
  } else if (command === "check") {
    const { labelsFor } = await import("./labels");
    const known = repo === DEFAULT_REPO ? new Set(labelsFor("brain-kit").map(label => label.name)) : undefined;
    const rows = listOpen(gh, repo).filter(issue => !issue.isPullRequest).map(issue => ({ number: issue.number, title: issue.title,
      problems: labelProblems(issue, known), gaps: labelGaps(issue) })).filter(row => row.problems.length || row.gaps.length);
    print({ repo, contradictions: rows.filter(row => row.problems.length).map(({ gaps: _gaps, ...row }) => row),
      gaps: rows.filter(row => !row.problems.length).map(({ problems: _problems, title: _title, ...row }) => row) });
  } else if (command === "show") {
    const issue = readIssue(gh, repo, number());
    const { parseBlockers } = await import("./sync-project");
    const declared = parseBlockers(issue.body, repo);
    const blockers = declared.refs.map(ref => {
      const [owner, id] = ref.split("#") as [string, string];
      const result = gh(["api", `repos/${owner}/issues/${id}`, "--jq", "{state,state_reason,title} | tojson"]);
      if (result.code !== 0) return { ref, state: "unreadable" };
      const state = JSON.parse(result.stdout) as { state: string; state_reason: string | null; title: string };
      return { ref, state: state.state, ...(state.state_reason ? { reason: state.state_reason } : {}), title: state.title };
    });
    // The parent endpoint answers 404 with a JSON body when there is none; any other failure is unknown, not "no parent".
    const parentResult = gh(["api", `repos/${repo}/issues/${issue.number}/parent`, "--jq", "{number,title,state} | tojson"]);
    const parent = parentResult.code === 0 ? JSON.parse(parentResult.stdout) as { number: number; title: string; state: string }
      : /404|Not Found/.test(parentResult.stderr + parentResult.stdout) ? null : "unknown";
    const thread = text("thread");
    if (thread) {
      const comments = must(gh, ["api", "--paginate", `repos/${repo}/issues/${issue.number}/comments?per_page=100`,
        "--jq", ".[] | {at:.created_at,by:.user.login,role:.author_association,body} | tojson"]).split("\n").filter(Boolean)
        .map(line => JSON.parse(line) as { at: string; by: string; role: string; body: string });
      writeFileSync(thread, [`# #${issue.number} ${issue.title}`, "", issue.body.trimEnd(), ...comments.flatMap((entry, index) =>
        ["", `## Comment ${index + 1} of ${comments.length}, ${entry.at}, ${entry.by} (${entry.role})`, "", entry.body.trimEnd()])].join("\n") + "\n");
    }
    const group = (prefix: string) => issue.labels.filter(label => label.startsWith(prefix)).map(label => label.slice(prefix.length).trim());
    print({ number: issue.number, title: issue.title, state: issue.state, updatedAt: issue.updatedAt, epic: isEpic(issue),
      type: group("type:"), area: group("area:"), priority: group("priority:"), needs: group("needs:"),
      other: issue.labels.filter(label => !/^(?:type|area|priority|needs):/.test(label)),
      assignees: issue.assignees, milestone: issue.milestone, parent, blockers, unreadableBlockerLines: declared.unreadable,
      openPullRequests: activeWork(issue.number, listOpenPrs(gh, repo)), comments: issue.comments, bodyChars: issue.body.length,
      problems: labelProblems(issue), eligible: ineligible(issue) ?? true, ...(thread ? { thread } : {}) });
  } else if (command === "claim") {
    const branch = text("branch");
    if (!branch) throw new Error("claim needs --branch <name>: the claim comment records it");
    const before = readIssue(gh, repo, number());
    const reason = ineligible(before) ?? (before.labels.includes("blocked") && !flags.has("stack-reviewed") ? "is blocked, and no stack-selection review was declared" : null);
    if (reason) { print({ claimed: false, issue: before.number, reason: `#${before.number} ${reason}` }); return 1; }
    const me = must(gh, ["api", "user", "--jq", ".login"]).trim();
    must(gh, ["issue", "edit", String(before.number), "--repo", repo, "--add-assignee", "@me"]);
    const after = readIssue(gh, repo, before.number);
    // Assignment is not a lock. If anyone else is on the issue now, stop and leave their assignment alone.
    if (after.assignees.length !== 1 || after.assignees[0] !== me) {
      print({ claimed: false, issue: before.number, reason: "another owner appeared while claiming", assignees: after.assignees.length });
      return 1;
    }
    const token = (io.token ?? (() => `claim-${randomBytes(4).toString("hex")}`))();
    await comment(before.number, [`Claimed for implementation. Claim token: \`${token}\`. Branch: \`${branch}\`.`,
      ...(text("note") ? ["", text("note")!] : [])].join("\n"));
    print({ claimed: true, issue: before.number, token, branch });
  } else if (command === "release") {
    const issue = readIssue(gh, repo, number());
    const me = must(gh, ["api", "user", "--jq", ".login"]).trim();
    if (issue.state !== "open" || !issue.assignees.includes(me)) {
      print({ released: false, issue: issue.number, reason: issue.state !== "open" ? `the issue is ${issue.state}; its assignment stays as history` : "this account does not hold it" });
      return 0;
    }
    must(gh, ["issue", "edit", String(issue.number), "--repo", repo, "--remove-assignee", "@me"]);
    const after = readIssue(gh, repo, issue.number);
    if (after.assignees.includes(me)) throw new Error(`#${issue.number} is still assigned after the release; report it as unfinished`);
    print({ released: true, issue: issue.number, remainingAssignees: after.assignees.length });
  } else if (command === "labels") {
    const before = readIssue(gh, repo, number());
    const [add, remove] = [list(text("add")), list(text("remove"))];
    if (!add.length && !remove.length) throw new Error("labels needs --add or --remove");
    if (before.state !== "open") throw new Error(`#${before.number} is ${before.state}; a closed issue is not relabelled`);
    if (text("updated-at") && text("updated-at") !== before.updatedAt) {
      print({ applied: false, issue: before.number, reason: "the issue changed since you read it; read it again and reconcile", updatedAt: before.updatedAt });
      return 1;
    }
    const { labelsFor } = await import("./labels");
    const known = repo === DEFAULT_REPO ? new Set(labelsFor("brain-kit").map(label => label.name)) : undefined;
    const unknown = known ? add.filter(label => !known.has(label)) : [];
    if (unknown.length) throw new Error(`Not in the label manifest (scripts/labels.ts): ${unknown.join(", ")}`);
    const wanted = [...new Set([...before.labels.filter(label => !remove.includes(label)), ...add])].sort();
    const problems = labelProblems({ labels: wanted });
    if (problems.length) { print({ applied: false, issue: before.number, reason: "the result would contradict the readiness rules", problems }); return 1; }
    const effective = { add: add.filter(label => !before.labels.includes(label)), remove: remove.filter(label => before.labels.includes(label)) };
    if (effective.add.length || effective.remove.length) {
      must(gh, ["issue", "edit", String(before.number), "--repo", repo,
        ...(effective.add.length ? ["--add-label", effective.add.join(",")] : []), ...(effective.remove.length ? ["--remove-label", effective.remove.join(",")] : [])]);
    }
    const after = readIssue(gh, repo, before.number);
    const actual = [...after.labels].sort();
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`#${before.number} has ${actual.join(", ")} after the edit, not ${wanted.join(", ")}; someone else changed it`);
    print({ applied: true, issue: before.number, added: effective.add, removed: effective.remove, labels: actual, gaps: labelGaps(after), updatedAt: after.updatedAt });
  } else {
    io.out("usage: bun scripts/issue-queue.ts candidates | snapshot | show <n> | check | claim <n> --branch <name> | release <n> | labels <n> --add a,b --remove c,d");
    return 2;
  }
  return 0;
}

if (import.meta.main) {
  try { process.exit(await main(process.argv.slice(2), { out: text => console.log(text) })); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(2); }
}
