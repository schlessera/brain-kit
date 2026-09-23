// Seed and maintain the "brain-kit roadmap" GitHub Project.
//
//   bun scripts/sync-project.ts            # dry run: say what would change
//   bun scripts/sync-project.ts --apply
//
// The project spans BOTH repositories — the public `brain-kit` and the private
// `brain-ui` deployment shell — because they ship as one system and a board
// that shows half of it is a board you have to remember to look past.
//
// Needs the `project` scope, which `repo` does not include:
//
//   gh auth refresh -s project
//
// What this script cannot do, and why:
//
// - **Views.** The GitHub API exposes no mutation for creating a project view,
//   so the board, roadmap and filtered tables are made once in the web UI.
//   `docs/process/github.md` lists the ones this project is meant to have.
// - **The Status field's options.** Status is created by GitHub with
//   Todo / In Progress / Done and `gh project` cannot edit an existing field's
//   options. Adjust it in the UI; everything else here is idempotent around it.
//
// Everything it CAN do is idempotent: run it again after filing issues and it
// adds the new ones and leaves the rest alone.

import { labelsFor } from "./labels.ts";

const OWNER = "schlessera";
const TITLE = "brain-kit roadmap";
const REPOS = ["schlessera/brain-kit", "schlessera/brain-ui"] as const;

/**
 * The roadmap themes. A track is what an epic is about; a milestone is which
 * release it ships in. They are different questions and they get different
 * fields.
 *
 * Membership is seeded from the epic an issue belongs to. Standalone issues
 * are listed explicitly, because "which theme is this" is a judgement and not
 * something a label can answer.
 */
const TRACKS: Record<string, { epics: number[]; also: number[]; repo: string }[]> = {
  // Getting the thing into somebody else's hands: the two templates, and the
  // documentation that has to stop pointing at a private installation.
  Distribution: [{ epics: [26, 70], also: [69], repo: "schlessera/brain-kit" }],
  Hardening: [
    { epics: [], also: [38], repo: "schlessera/brain-kit" },
    { epics: [19], also: [], repo: "schlessera/brain-ui" },
  ],
  Reliability: [
    { epics: [], also: [30, 31, 52, 53, 65, 66], repo: "schlessera/brain-kit" },
    { epics: [], also: [25], repo: "schlessera/brain-ui" },
  ],
  "Design system": [
    { epics: [39], also: [46, 47, 48], repo: "schlessera/brain-kit" },
    { epics: [], also: [24], repo: "schlessera/brain-ui" },
  ],
  "Answer quality": [{ epics: [], also: [49, 50], repo: "schlessera/brain-kit" }],
  Modules: [{ epics: [32], also: [59, 60], repo: "schlessera/brain-kit" }],
  "Async collaboration": [{ epics: [51], also: [], repo: "schlessera/brain-kit" }],
  Voice: [{ epics: [54], also: [], repo: "schlessera/brain-kit" }],
  "Contract and 1.0": [{ epics: [56], also: [57, 58, 61, 62], repo: "schlessera/brain-kit" }],
};

const SIZES = ["XS", "S", "M", "L"];

interface ProjectField {
  id: string;
  name: string;
  type?: string;
  options?: { id: string; name: string }[];
}

async function gh(args: string[]): Promise<string> {
  const child = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`gh ${args.join(" ")} failed (${code}):\n${stderr.trim()}`);
  return stdout;
}

interface Project {
  number: number;
  id: string;
  url?: string;
}

async function ensureProject(apply: boolean): Promise<Project> {
  const raw = await gh(["project", "list", "--owner", OWNER, "--format", "json", "--limit", "100"]);
  const existing = (
    JSON.parse(raw).projects as (Project & { title: string })[]
  ).find((project) => project.title === TITLE);
  if (existing) return existing;
  if (!apply) {
    console.log(`would create project "${TITLE}"`);
    return { number: -1, id: "" };
  }
  const created = JSON.parse(
    await gh(["project", "create", "--owner", OWNER, "--title", TITLE, "--format", "json"]),
  ) as Project;
  console.log(`created project #${created.number}`);
  return created;
}

/** What each item currently carries, keyed by issue URL. */
async function boardValues(
  projectNumber: number,
): Promise<Map<string, Record<string, string | undefined>>> {
  const raw = await gh([
    "project", "item-list", String(projectNumber), "--owner", OWNER,
    "--format", "json", "--limit", "500",
  ]);
  type Row = { status?: string; priority?: string; track?: string; content?: { url?: string } };
  return new Map(
    (JSON.parse(raw).items as Row[])
      .filter((item) => item.content?.url)
      .map((item) => [
        item.content!.url!,
        { Status: item.status, Priority: item.priority, Track: item.track },
      ]),
  );
}

/** The items actually on the board, keyed by issue URL. */
async function boardItems(projectNumber: number): Promise<Map<string, string>> {
  const raw = await gh([
    "project",
    "item-list",
    String(projectNumber),
    "--owner",
    OWNER,
    "--format",
    "json",
    "--limit",
    "500",
  ]);
  return new Map(
    (JSON.parse(raw).items as { id: string; content?: { url?: string } }[])
      .filter((item) => item.content?.url)
      .map((item) => [item.content!.url!, item.id]),
  );
}

async function listFields(projectNumber: number): Promise<ProjectField[]> {
  const raw = await gh([
    "project",
    "field-list",
    String(projectNumber),
    "--owner",
    OWNER,
    "--format",
    "json",
    "--limit",
    "100",
  ]);
  return JSON.parse(raw).fields as ProjectField[];
}

/** The fields the board needs beyond what GitHub creates. */
function wantedFields(): { name: string; dataType: string; options?: string[] }[] {
  const priorities = labelsFor("brain-kit")
    .filter((label) => label.name.startsWith("priority: "))
    .map((label) => label.name.replace("priority: ", "").toUpperCase());
  return [
    // Mirrors the `priority:` labels rather than replacing them: the label is
    // what you see in an issue list without opening the board, the field is
    // what the board sorts on.
    { name: "Priority", dataType: "SINGLE_SELECT", options: priorities },
    { name: "Track", dataType: "SINGLE_SELECT", options: Object.keys(TRACKS) },
    { name: "Size", dataType: "SINGLE_SELECT", options: SIZES },
    // The roadmap layout's two ends. Both are intent, never a commitment.
    //
    // Two fields rather than one because the roadmap's date picker will not
    // take the same field for start and target — choosing it for one clears
    // the other. With only `Target` an item renders as a point; with both it
    // renders as a bar, which is what makes a roadmap readable at a glance.
    //
    // An item with neither simply does not appear on that view, which is the
    // right default: most issues here are not scheduled, and inventing a date
    // to make a chart look full is how a roadmap stops being believed.
    { name: "Start", dataType: "DATE" },
    { name: "Target", dataType: "DATE" },
  ];
}

async function ensureFields(projectNumber: number, apply: boolean): Promise<ProjectField[]> {
  let fields = await listFields(projectNumber);
  for (const wanted of wantedFields()) {
    if (fields.some((field) => field.name === wanted.name)) continue;
    if (!apply) {
      console.log(`would create field ${wanted.name} (${wanted.dataType})`);
      continue;
    }
    const args = [
      "project",
      "field-create",
      String(projectNumber),
      "--owner",
      OWNER,
      "--name",
      wanted.name,
      "--data-type",
      wanted.dataType,
    ];
    if (wanted.options) args.push("--single-select-options", wanted.options.join(","));
    await gh(args);
    console.log(`created field ${wanted.name}`);
  }
  if (apply) fields = await listFields(projectNumber);
  return fields;
}

interface Issue {
  number: number;
  title: string;
  url: string;
  labels: { name: string }[];
  body: string;
  repo: string;
}

async function openIssues(): Promise<Issue[]> {
  const all: Issue[] = [];
  for (const repo of REPOS) {
    const raw = await gh([
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--limit",
      "200",
      "--json",
      "number,title,url,labels,body",
    ]);
    for (const issue of JSON.parse(raw) as Omit<Issue, "repo">[]) all.push({ ...issue, repo });
  }
  return all;
}

/** Which sub-issues each epic owns, so a track seeds through the hierarchy. */
async function subIssueNumbers(repo: string, parent: number): Promise<number[]> {
  try {
    const raw = await gh(["api", `repos/${repo}/issues/${parent}/sub_issues`, "--jq", ".[].number"]);
    return raw.split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

export function trackFor(
  issue: { number: number; repo: string },
  membership: Map<string, Set<string>>,
): string | undefined {
  for (const [track, members] of membership) {
    if (members.has(`${issue.repo}#${issue.number}`)) return track;
  }
  return undefined;
}

/**
 * Status the board can derive, and the ones it must not touch.
 *
 * `In progress` and `Done` are statements about a human or an agent, not about
 * the issue's labels, so a re-run leaves them exactly as it found them. The
 * other three are derived, and re-deriving them on every run is the point:
 * close a blocker, and a dependant that names it with `Blocked by #N` loses
 * its `blocked` label and becomes Ready without anyone remembering.
 */
const DERIVED_STATUSES = new Set(["Backlog", "Ready", "In review"]);

export function statusFor(
  issue: { labels: { name: string }[] },
  hasOpenPullRequest: boolean,
): string {
  const labels = issue.labels.map((label) => label.name);
  // An issue with a PR open against it is in review whatever its labels say.
  if (hasOpenPullRequest) return "In review";
  // An epic is never worked directly, so it is never Ready.
  if (labels.includes("epic")) return "Backlog";
  // `Ready` means pickable RIGHT NOW. A `needs:` label or a sibling blocker
  // makes it not that, and a Ready filter that hands an agent a blocked issue
  // is worse than no filter at all.
  const blocked = labels.includes("blocked") || labels.some((l) => l.startsWith("needs: "));
  if (blocked) return "Backlog";
  return labels.includes("agent-ready") ? "Ready" : "Backlog";
}

export type BlockerState = "open" | "closed";

/**
 * The blockers an issue body names, as `owner/repo#number`.
 *
 * The convention is `Blocked by #N` on its own line (`docs/process/github.md`).
 * Prose that merely mentions being blocked names nothing a script can check,
 * and a line inside a code fence is an example, not a dependency.
 */
export function blockersIn(body: string, repo: string): string[] {
  return parseBlockers(body, repo).refs;
}

/** `#12`, `owner/repo#12`, or a GitHub issue or pull request URL. */
const BLOCKER_REF =
  /^(?:([\w.-]+\/[\w.-]+)?#(\d+)|https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)(?:[#?]\S*?)?)(?=$|[\s,.;:)!?])/;

/** "blocked by" under any markdown formatting: `__Blocked by__`, `*blocked* by`. */
const MENTIONS_BLOCKED_BY = /blocked[\s_*`~-]*by(?![a-z])/i;

/**
 * The blockers an issue body names, and the declarations it could not read.
 *
 * A declaration is a `Blocked by` line whose text starts with a list of
 * references (`#1`, `#1, #2`, `#1 and o/r#2`); anything after the list is
 * commentary. A declaration that starts with something else, or that still
 * mentions a reference after its list, is `unreadable` — reading only part of
 * it could clear a label while the part it skipped is still open.
 */
export function parseBlockers(body: string, repo: string): { refs: string[]; unreadable: string[] } {
  const refs: string[] = [];
  const lines = body.split(/\r?\n/);
  /** Indices of the lines read in full as plain declarations. */
  const read = new Set<number>();
  // The open fence, if any. A fence closes only on the same character, at
  // least as long, with nothing after it. Lines inside a fence are examples
  // and are never read as declarations.
  let fence: { char: string; length: number } | undefined;
  // HTML comments are blanked the same way: what a reader cannot see is not
  // a declaration the script may act on. Newlines survive, so indices match.
  const visible = body.replace(/<!--[\s\S]*?(?:-->|$)/g, (hidden) => hidden.replace(/[^\r\n]/g, " "));
  visible.split(/\r?\n/).forEach((line, index) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const run = marker?.[1];
      if (run && run[0] === fence.char && run.length >= fence.length && !marker![2].trim()) {
        fence = undefined;
      }
      return;
    }
    if (marker && !(marker[1][0] === "`" && marker[2].includes("`"))) {
      fence = { char: marker[1][0], length: marker[1].length };
      return;
    }
    // A plain declaration: at the start of the line, optionally a top-level
    // bullet and bold.
    const match = line.match(/^(?:[-*] )?(?:\*\*)?blocked by(?:\*\*)?:?[ \t]+(.*)$/i);
    if (!match) return;
    let rest = match[1];
    const found: string[] = [];
    for (;;) {
      const ref = rest.match(BLOCKER_REF);
      if (!ref) break;
      found.push(ref[2] ? `${ref[1] ?? repo}#${ref[2]}` : `${ref[3]}#${ref[4]}`);
      rest = rest.slice(ref[0].length);
      const separator = rest.match(/^\s*(?:,\s*and|,|and)\s+|^,\s*/i);
      if (!separator || !BLOCKER_REF.test(rest.slice(separator[0].length))) break;
      rest = rest.slice(separator[0].length);
    }
    if (found.length === 0 || /#\d|github\.com\/\S+\/(?:issues|pull)\/\d/i.test(rest)) return;
    refs.push(...found);
    read.add(index);
  });
  // The safety net, and the rule that makes the rest safe: every line of the
  // RAW body that mentions "blocked by", however it is formatted or wherever
  // it sits — a quote, a heading, a fence, a comment, prose — is either a
  // declaration read in full above or unreadable. A declaration the parser
  // did not recognise can therefore never be skipped while the ones it did
  // recognise clear the label.
  const unreadable = lines.flatMap((line, index) =>
    MENTIONS_BLOCKED_BY.test(line) && !read.has(index) ? [line.trim()] : [],
  );
  return { refs, unreadable };
}

export type BlockedVerdict =
  | { kind: "not-blocked" }
  | { kind: "unverifiable"; reason: string }
  | { kind: "still-blocked"; open: string[] }
  | { kind: "cleared"; closed: string[] };

/**
 * Whether a `blocked` label still has a reason.
 *
 * Only a label whose every named blocker is known to be closed is `cleared`.
 * No `Blocked by` line, or a blocker whose state could not be read, is
 * `unverifiable`: the label may be right for a reason nobody wrote down, and
 * removing it would hand an agent a trap through the Ready view.
 */
export function blockedVerdict(
  issue: { labels: { name: string }[]; body?: string; repo: string },
  stateOf: (ref: string) => BlockerState | undefined,
): BlockedVerdict {
  if (!issue.labels.some((label) => label.name === "blocked")) return { kind: "not-blocked" };
  const { refs: blockers, unreadable } = parseBlockers(issue.body ?? "", issue.repo);
  if (unreadable.length > 0) {
    return { kind: "unverifiable", reason: `cannot read the declaration "${unreadable[0]}"` };
  }
  if (blockers.length === 0) {
    return { kind: "unverifiable", reason: "labelled `blocked` with no `Blocked by #N` line" };
  }
  const unknown = blockers.filter((ref) => stateOf(ref) === undefined);
  if (unknown.length > 0) {
    return { kind: "unverifiable", reason: `could not read the state of ${unknown.join(", ")}` };
  }
  const open = blockers.filter((ref) => stateOf(ref) === "open");
  if (open.length > 0) return { kind: "still-blocked", open };
  return { kind: "cleared", closed: blockers };
}

interface BlockableIssue {
  number: number;
  repo: string;
  labels: { name: string }[];
  body?: string;
}

export interface BlockerIO {
  state(ref: string): Promise<BlockerState | undefined>;
  removeLabel(issue: BlockableIssue): Promise<void>;
  comment(issue: BlockableIssue, text: string): Promise<void>;
  /** Whether the issue already has a comment containing `marker`. */
  hasComment(issue: BlockableIssue, marker: string): Promise<boolean>;
}

/**
 * Whether a comment is this script's notice for `marker`: the whole comment,
 * one line, so the marker quoted inside someone else's comment — or an
 * example of the notice in a code block — does not suppress the real one.
 */
export function isOwnNotice(body: string, marker: string): boolean {
  return body.startsWith("Unblocked: ") && body.endsWith(marker) && !body.includes("\n");
}

/** `#110` in its own repository, `owner/repo#110` from another. */
function shortRef(ref: string, repo: string): string {
  return ref.startsWith(`${repo}#`) ? ref.slice(repo.length) : ref;
}

/**
 * Clear `blocked` from every issue whose named blockers have all closed.
 *
 * The comment goes first and carries a marker naming the blockers; the label
 * comes off second. A run that fails between the two leaves the label on, so
 * the next run retries — and finds the marker, so it removes the label
 * without commenting again. Either order without the marker loses one of the
 * two: removing first strands an issue with no comment if the comment fails,
 * commenting first posts it twice if the removal fails. Runs are assumed not
 * to overlap. On success the in-memory labels are updated too, so the same
 * run derives the issue's Status from what it now carries.
 */
export async function reconcileBlocked<T extends BlockableIssue>(
  issues: T[],
  io: BlockerIO,
  apply: boolean,
): Promise<{
  cleared: { issue: T; closed: string[] }[];
  unverifiable: { issue: T; reason: string }[];
}> {
  const cleared: { issue: T; closed: string[] }[] = [];
  const unverifiable: { issue: T; reason: string }[] = [];
  const known = new Map<string, BlockerState | undefined>();
  for (const issue of issues) {
    if (!issue.labels.some((label) => label.name === "blocked")) continue;
    for (const ref of parseBlockers(issue.body ?? "", issue.repo).refs) {
      if (!known.has(ref)) known.set(ref, await io.state(ref));
    }
    const verdict = blockedVerdict(issue, (ref) => known.get(ref));
    if (verdict.kind === "unverifiable") unverifiable.push({ issue, reason: verdict.reason });
    if (verdict.kind !== "cleared") continue;
    cleared.push({ issue, closed: verdict.closed });
    if (!apply) continue;
    const marker = `<!-- sync-project: unblocked by ${[...new Set(verdict.closed)].sort().join(" ")} -->`;
    if (!(await io.hasComment(issue, marker))) {
      const names = verdict.closed.map((ref) => shortRef(ref, issue.repo));
      await io.comment(
        issue,
        `Unblocked: ${names.join(", ")} ${names.length === 1 ? "is" : "are"} closed, so ` +
          `\`scripts/sync-project.ts\` is removing the \`blocked\` label. ${marker}`,
      );
    }
    await io.removeLabel(issue);
    issue.labels = issue.labels.filter((label) => label.name !== "blocked");
  }
  return { cleared, unverifiable };
}

/**
 * Issues an open PR says it closes, as `owner/repo#number`.
 *
 * Read from the PR bodies rather than from GitHub's linked-issue field,
 * because `Closes #n` in the body is what actually closes the issue on merge
 * and is therefore the thing that is true.
 */
async function issuesUnderReview(): Promise<Set<string>> {
  const under = new Set<string>();
  for (const repo of REPOS) {
    const raw = await gh([
      "pr", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json", "number,body",
    ]);
    for (const pr of JSON.parse(raw) as { body?: string }[]) {
      for (const match of (pr.body ?? "").matchAll(/(?:closes|fixes|resolves)\s+#(\d+)/gi)) {
        under.add(`${repo}#${match[1]}`);
      }
    }
  }
  return under;
}

export function priorityFor(issue: { labels: { name: string }[] }): string | undefined {
  const label = issue.labels.find((l) => l.name.startsWith("priority: "));
  return label?.name.replace("priority: ", "").toUpperCase();
}

/** The tracker, through `gh`, for {@link reconcileBlocked}. */
const trackerIO: BlockerIO = {
  async state(ref) {
    const [repo, number] = ref.split("#");
    try {
      // The issues endpoint answers for pull requests too. A PR closed without
      // merging did not land what the dependant waits for, so it is neither
      // open nor closed here: the verdict becomes unverifiable.
      const state = (
        await gh([
          "api",
          `repos/${repo}/issues/${number}`,
          "--jq",
          'if .pull_request and .state == "closed" and .pull_request.merged_at == null then "unmerged" else .state end',
        ])
      ).trim();
      return state === "open" || state === "closed" ? state : undefined;
    } catch {
      return undefined;
    }
  },
  async removeLabel(issue) {
    await gh(["issue", "edit", String(issue.number), "--repo", issue.repo, "--remove-label", "blocked"]);
  },
  async comment(issue, text) {
    await gh(["issue", "comment", String(issue.number), "--repo", issue.repo, "--body", text]);
  },
  async hasComment(issue, marker) {
    // One JSON string per comment, so a comment is compared whole.
    const bodies = await gh([
      "api", "--paginate", `repos/${issue.repo}/issues/${issue.number}/comments`,
      "--jq", ".[].body | @json",
    ]);
    return bodies
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string)
      .some((body) => isOwnNotice(body, marker));
  },
};

async function buildMembership(): Promise<Map<string, Set<string>>> {
  const membership = new Map<string, Set<string>>();
  for (const [track, groups] of Object.entries(TRACKS)) {
    const members = new Set<string>();
    for (const group of groups) {
      for (const epic of group.epics) {
        members.add(`${group.repo}#${epic}`);
        for (const sub of await subIssueNumbers(group.repo, epic)) {
          members.add(`${group.repo}#${sub}`);
        }
      }
      for (const number of group.also) members.add(`${group.repo}#${number}`);
    }
    membership.set(track, members);
  }
  return membership;
}

if (import.meta.main) {
  const apply = process.argv.includes("--apply");

  // `repo` does not imply `project`, and the failure without it is a raw
  // GraphQL scope error several frames down. Say it here instead.
  const scopes = await gh(["auth", "status"]).catch(() => "");
  if (!/\bproject\b/.test(scopes)) {
    console.error(
      "The `project` scope is missing. GitHub Projects is a separate scope from `repo`.\n" +
        "Grant it, then re-run:\n\n  gh auth refresh -s project\n",
    );
    process.exit(1);
  }

  const project = await ensureProject(apply);
  if (project.number === -1) {
    console.log("\nRe-run with --apply to create the project, then run again to seed it.");
    process.exit(0);
  }

  for (const repo of REPOS) {
    const [, name] = repo.split("/");
    if (apply) {
      try {
        await gh(["project", "link", String(project.number), "--owner", OWNER, "--repo", name]);
      } catch {
        // Already linked; `link` is not idempotent and says so by failing.
      }
    }
  }

  const fields = await ensureFields(project.number, apply);
  const byName = new Map(fields.map((field) => [field.name, field]));

  const existing = await boardItems(project.number);

  const membership = await buildMembership();
  const issues = await openIssues();
  const underReview = await issuesUnderReview();
  const currentValues = await boardValues(project.number);

  // Before Status is derived: an issue unblocked here is Ready in this run.
  const blockers = await reconcileBlocked(issues, trackerIO, apply);
  for (const { issue, closed } of blockers.cleared) {
    console.log(
      `${apply ? "unblocked" : "would unblock"} ${issue.repo}#${issue.number}: ` +
        `every blocker is closed (${closed.join(", ")})`,
    );
  }
  for (const { issue, reason } of blockers.unverifiable) {
    console.log(`cannot verify blocked ${issue.repo}#${issue.number}: ${reason}`);
  }

  let added = 0;
  let edited = 0;
  for (const issue of issues) {
    let itemId = existing.get(issue.url);
    if (!itemId) {
      if (!apply) {
        console.log(`would add ${issue.repo}#${issue.number}  ${issue.title}`);
        added++;
        continue;
      }
      const result = JSON.parse(
        await gh([
          "project",
          "item-add",
          String(project.number),
          "--owner",
          OWNER,
          "--url",
          issue.url,
          "--format",
          "json",
        ]),
      ) as { id: string };
      itemId = result.id;
      added++;
    }

    const current = currentValues.get(issue.url)?.Status;
    // Never drag an item out of a status a person put it in.
    const wantedStatus =
      current === undefined || DERIVED_STATUSES.has(current)
        ? statusFor(issue, underReview.has(`${issue.repo}#${issue.number}`))
        : undefined;

    const assignments: { field: string; value: string | undefined }[] = [
      { field: "Priority", value: priorityFor(issue) },
      { field: "Track", value: trackFor(issue, membership) },
      { field: "Status", value: wantedStatus },
    ];
    for (const { field, value } of assignments) {
      if (!value) continue;
      // Skip a write that would change nothing. Three fields across 44 items
      // is 132 API calls per run otherwise, all of them saying what the board
      // already says.
      if (currentValues.get(issue.url)?.[field] === value) continue;
      const definition = byName.get(field);
      const option = definition?.options?.find((o) => o.name === value);
      if (!definition || !option) continue;
      if (!apply) continue;
      await gh([
        "project",
        "item-edit",
        "--id",
        itemId,
        "--project-id",
        project.id,
        "--field-id",
        definition.id,
        "--single-select-option-id",
        option.id,
      ]);
      edited++;
    }
  }

  console.log(
    `\n${apply ? "Applied" : "Dry run"}: ${added} item(s) added, ${edited} field value(s) set.`,
  );
  if (!apply) {
    console.log("Re-run with --apply to make these changes.");
    process.exit(0);
  }

  // Count what is on the BOARD, not what was asked for. The first real run of
  // this script reported 44 added and 31 landed: `item-add` returns before the
  // item is listable, so an add issued against a stale listing is a silent
  // no-op. Re-running fixes it, which is the point of the whole script being
  // idempotent — but only if it says so rather than claiming success.
  const onBoard = await boardItems(project.number);
  const missing = issues.filter((issue) => !onBoard.has(issue.url));
  if (missing.length > 0) {
    console.log(
      `\n${missing.length} issue(s) did not land. This is expected on a first run; ` +
        `run the script again and they will be picked up:\n` +
        missing.map((issue) => `  ${issue.repo}#${issue.number}`).join("\n"),
    );
  } else {
    console.log(`All ${issues.length} open issue(s) are on the board.`);
  }

  console.log(`
Two things this script cannot do — finish them once, in the web UI:

  1. Status options. GitHub created Status with Todo / In Progress / Done, and
     no API can edit an existing field's options. Change them to
     Backlog / Ready / In progress / In review / Done.

  2. Views. The API exposes no mutation for creating one. Make these four:
       Board      — board layout, grouped by Status
       Roadmap    — roadmap layout on Target, grouped by Track
       Ready      — table, filter: status:Ready label:agent-ready, sorted by Priority
       Epics      — table, filter: label:epic

${project.url ?? `https://github.com/users/${OWNER}/projects/${project.number}`}`);
}
