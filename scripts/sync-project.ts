// Seed and maintain the "brain-kit roadmap" GitHub Project.
//
//   bun scripts/sync-project.ts                       # dry run, whole board
//   bun scripts/sync-project.ts --issue owner/repo#N  # dry run, one issue
//   bun scripts/sync-project.ts --pr owner/repo#N     # dry run, what a PR closes
//   gh workflow run project-sync --repo schlessera/brain-kit   # apply the sweep
//
// `--apply` is what `.github/workflows/project-sync.yml` runs: `--issue` or
// `--pr` per event (a few GraphQL points), and the full sweep daily (about
// 520 of the account's 5,000 points per hour, measured 2026-09-24). Run
// `--apply` through the workflow only: its shared concurrency group serializes
// all event and sweep paths. A terminal apply bypasses that group and can
// post a duplicate unblock notice.
//
// The project spans the three public repositories that make up the
// open-source project: `brain-kit`, `brain-template` and
// `brain-hosting-template`. The maintainer's private instance repositories are
// never on it (AGENTS.md, "The five repositories").
//
// Needs the `project` and `read:org` scopes, which `repo` does not include:
//
//   gh auth refresh -s project,read:org
//
// What this script does not do, and why:
//
// - **Views.** The board, roadmap and filtered tables are made once in the web
//   UI. GraphQL has `createProjectV2View` (checked 2026-09-24); this script
//   does not use it because the views are set up once and then left alone.
//   `docs/process/github.md` lists the ones this project is meant to have.
// - **The Status field's options.** Status is created by GitHub with
//   Todo / In Progress / Done. `gh project` cannot edit an existing field's
//   options, but the GraphQL `updateProjectV2Field` mutation can, with
//   `singleSelectOptions` (used on 2026-09-24). This board's options are
//   already Backlog / Ready / In progress / In review / Done, so the script
//   leaves them alone, and a Status it cannot find an option for is skipped.
//
// Everything it CAN do is idempotent: run it again after filing issues and it
// adds the new ones and leaves the rest alone.

import { labelsFor } from "./labels.ts";

const OWNER = "schlessera";
const TITLE = "brain-kit roadmap";
export const REPOS = [
  "schlessera/brain-kit",
  "schlessera/brain-template",
  "schlessera/brain-hosting-template",
] as const;

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
  Distribution: [
    { epics: [26, 70], also: [69], repo: "schlessera/brain-kit" },
    { epics: [], also: [1, 2, 3], repo: "schlessera/brain-template" },
  ],
  Hardening: [{ epics: [], also: [38, 152, 251, 282], repo: "schlessera/brain-kit" }],
  Reliability: [{
    epics: [89, 191, 366, 367, 577, 578, 735, 736],
    also: [30, 31, 58, 61, 65, 66, 72, 142, 210, 243, 254, 286, 290, 544, 547, 591],
    repo: "schlessera/brain-kit",
  }],
  "Design system": [{
    epics: [39, 734],
    also: [46, 47, 48, 88, 93, 541, 543],
    repo: "schlessera/brain-kit",
  }],
  "Answer quality": [{ epics: [363, 364, 365], also: [50], repo: "schlessera/brain-kit" }],
  Modules: [{ epics: [32, 524, 731, 732, 733], also: [59, 60], repo: "schlessera/brain-kit" }],
  "Async collaboration": [{ epics: [51], also: [], repo: "schlessera/brain-kit" }],
  Voice: [{ epics: [54], also: [91], repo: "schlessera/brain-kit" }],
  "Contract and 1.0": [{ epics: [56], also: [57, 62], repo: "schlessera/brain-kit" }],
};

const SIZES = ["XS", "S", "M", "L"];

interface ProjectField {
  id: string;
  name: string;
  type?: string;
  options?: { id: string; name: string }[];
}

/**
 * How the script reaches GitHub and the terminal. One object, so a test can
 * replace `gh` with a fake board and tracker and read what the run printed,
 * and run the real orchestration end to end without a network.
 */
export const runtime = {
  gh: spawnGh,
  log: (line: string) => console.log(line),
  error: (line: string) => console.error(line),
};

function gh(args: string[]): Promise<string> {
  return runtime.gh(args);
}

async function spawnGh(args: string[]): Promise<string> {
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
    runtime.log(`would create project "${TITLE}"`);
    return { number: -1, id: "" };
  }
  const created = JSON.parse(
    await gh(["project", "create", "--owner", OWNER, "--title", TITLE, "--format", "json"]),
  ) as Project;
  runtime.log(`created project #${created.number}`);
  return created;
}

/** Complete item IDs and managed field values, keyed by repository-qualified issue URL. */
async function readBoard(
  project: Project,
): Promise<Map<string, { itemId: string; current: Record<string, string | undefined> }>> {
  // Named fields avoid a second, nested field-values pagination. Read both
  // IDs and values in one traversal so the sweep uses the same snapshot.
  const query = `query($project: ID!, $after: String) {
    node(id: $project) {
      ... on ProjectV2 {
        items(first: 100, after: $after) {
          nodes {
            id
            content { ... on Issue { url } ... on PullRequest { url } }
            status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
            priority: fieldValueByName(name: "Priority") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
            track: fieldValueByName(name: "Track") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }`;
  type Value = { name?: string } | null;
  type Item = { id: string; content?: { url?: string } | null; status?: Value; priority?: Value; track?: Value };
  type Page = { nodes: (Item | null)[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
  const items = new Map<string, { itemId: string; current: Record<string, string | undefined> }>();
  const cursors = new Set<string>();
  let after: string | undefined;
  for (;;) {
    const args = ["api", "graphql", "-f", `query=${query}`, "-F", `project=${project.id}`];
    if (after !== undefined) args.push("-f", `after=${after}`);
    const response = JSON.parse(await gh(args)) as {
      data?: { node?: { items?: Page } | null };
      errors?: { message: string }[];
    };
    if (response.errors?.length) {
      throw new Error(`Cannot read project #${project.number}: ${response.errors.map((error) => error.message).join("; ")}`);
    }
    const page = response.data?.node?.items;
    if (!page || !Array.isArray(page.nodes) || typeof page.pageInfo?.hasNextPage !== "boolean") {
      throw new Error(`Cannot read project #${project.number}: missing items or page information`);
    }
    for (const item of page.nodes) {
      if (!item?.content?.url) continue;
      items.set(item.content.url, {
        itemId: item.id,
        current: { Status: item.status?.name, Priority: item.priority?.name, Track: item.track?.name },
      });
    }
    if (!page.pageInfo.hasNextPage) return items;
    const cursor = page.pageInfo.endCursor;
    if (page.nodes.length === 0 || typeof cursor !== "string" || !cursor || cursors.has(cursor)) {
      throw new Error(`Cannot read project #${project.number}: pagination did not advance`);
    }
    cursors.add(cursor);
    after = cursor;
  }
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
      runtime.log(`would create field ${wanted.name} (${wanted.dataType})`);
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
    runtime.log(`created field ${wanted.name}`);
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
async function subIssueRefs(repo: string, parent: number): Promise<string[]> {
  try {
    const raw = await gh(["api", "--paginate", `repos/${repo}/issues/${parent}/sub_issues`, "--jq", ".[].html_url"]);
    return raw.split("\n").flatMap((url) => {
      const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(url);
      const childRepo = match && boardRepo(match[1]!);
      return childRepo ? [`${childRepo}#${match![2]}`] : [];
    });
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
    // A line an HTML comment touched is never read: blanking may have erased
    // a reference from it, and a declaration must be read in full.
    if (line !== lines[index]) return;
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
 * commenting first posts it twice if the removal fails. The project-sync
 * workflow serializes all apply paths in one concurrency group; the marker
 * makes retries safe within that group, but is not a concurrent write lock.
 * Terminal applies bypass serialization. The in-memory labels are updated in
 * both modes (after the writes, when applying), so the same run derives Status
 * from what it now carries, and a dry run reports the Status `--apply` would set.
 */
export async function reconcileBlocked<T extends BlockableIssue>(
  issues: T[],
  io: BlockerIO,
  apply: boolean,
  repos: readonly string[],
): Promise<{
  cleared: { issue: T; closed: string[] }[];
  unverifiable: { issue: T; reason: string }[];
}> {
  const cleared: { issue: T; closed: string[] }[] = [];
  const unverifiable: { issue: T; reason: string }[] = [];
  const known = new Map<string, BlockerState | undefined>();
  for (const issue of issues) {
    if (!issue.labels.some((label) => label.name === "blocked")) continue;
    const refs = parseBlockers(issue.body ?? "", issue.repo).refs;
    // The token can read more than the board covers. A blocker outside the
    // board's repositories is never looked up, so an edited body cannot make
    // this public run read a private issue's state and report it in a comment.
    // GitHub owner and repository names are case-insensitive, so compare
    // them that way: `Schlessera/Brain-Kit#1` is on the board.
    const board = new Set(repos.map((repo) => repo.toLowerCase()));
    const outside = refs.filter((ref) => !board.has(ref.slice(0, ref.lastIndexOf("#")).toLowerCase()));
    if (outside.length > 0) {
      unverifiable.push({
        issue,
        reason: `names a blocker outside the board's repositories: ${outside.join(", ")}`,
      });
      continue;
    }
    for (const ref of refs) {
      if (!known.has(ref)) known.set(ref, await io.state(ref));
    }
    const verdict = blockedVerdict(issue, (ref) => known.get(ref));
    if (verdict.kind === "unverifiable") unverifiable.push({ issue, reason: verdict.reason });
    if (verdict.kind !== "cleared") continue;
    cleared.push({ issue, closed: verdict.closed });
    if (!apply) {
      // Project the removal without making it, so a dry run derives the same
      // Status that `--apply` will, and reports it.
      issue.labels = issue.labels.filter((label) => label.name !== "blocked");
      continue;
    }
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
/**
 * The issues a PR body says it closes, as `owner/repo#number`. Only the
 * same-repository form `Closes #12` is read, because that is the form this
 * repository's PR template uses.
 */
export function closingRefs(body: string, repo: string): string[] {
  return [...body.matchAll(/(?:closes|fixes|resolves)\s+#(\d+)/gi)].map((m) => `${repo}#${m[1]}`);
}

async function issuesUnderReview(repos: readonly string[] = REPOS): Promise<Set<string>> {
  const under = new Set<string>();
  for (const repo of repos) {
    const raw = await gh([
      "pr", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json", "number,body",
    ]);
    for (const pr of JSON.parse(raw) as { body?: string }[]) {
      for (const ref of closingRefs(pr.body ?? "", repo)) under.add(ref);
    }
  }
  return under;
}

/**
 * The scopes the sync needs beyond repository access, each with the broader
 * scopes that include it. GitHub normalises a token's scopes and drops one
 * that a broader scope already covers, so a token granted `admin:org` reports
 * no `read:org` at all. `read:project` does not cover `project`: it is
 * read-only.
 */
export const REQUIRED_SCOPES = {
  project: ["project"],
  "read:org": ["read:org", "write:org", "admin:org"],
} as const;

/** The required scopes a token's scope set does not cover. */
export function missingScopes(scopes: Set<string>): string[] {
  return Object.entries(REQUIRED_SCOPES)
    .filter(([, coveredBy]) => !coveredBy.some((scope) => scopes.has(scope)))
    .map(([scope]) => scope);
}

/**
 * The OAuth scopes of the token that answered, from `gh api --include`
 * output. Exact names only: `read:project` is not `project`. A fine-grained
 * token sends no header at all, which reads as no scopes.
 */
export function scopesFromHeaders(response: string): Set<string> {
  const header = response.split(/\r?\n\r?\n/, 1)[0];
  const line = header.split(/\r?\n/).find((l) => /^x-oauth-scopes:/i.test(l));
  if (!line) return new Set();
  return new Set(
    line
      .slice(line.indexOf(":") + 1)
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean),
  );
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
        for (const sub of await subIssueRefs(group.repo, epic)) {
          members.add(sub);
        }
      }
      for (const number of group.also) members.add(`${group.repo}#${number}`);
    }
    membership.set(track, members);
  }
  return membership;
}

/** One board item's field writes, injected so a test can watch them. */
export interface BoardIO {
  /** Put the issue on the board and return its item id. */
  add(issue: { url: string }): Promise<string>;
  /** Set a single-select field on an item. */
  edit(itemId: string, fieldId: string, optionId: string): Promise<void>;
}

/**
 * Bring one issue's board item in line with its labels: add it if missing,
 * then write Priority, Track and Status where they differ. The full sweep and
 * the single-issue sync both go through here, so they cannot disagree.
 *
 * A Status a person set (`In progress`, `Done`) is never overwritten. A dry
 * run prints what it would write and writes nothing. In apply mode a `set`
 * line is printed only after its write succeeds.
 */
export async function syncItem(
  issue: Issue,
  ctx: {
    apply: boolean;
    fields: Map<string, ProjectField>;
    membership: Map<string, Set<string>>;
    underReview: Set<string>;
    /** The item's current values, or undefined when it is not on the board. */
    current?: Record<string, string | undefined>;
    itemId?: string;
    io: BoardIO;
    /** Incremented per write as it succeeds, so a failed run still says what it did. */
    counts: Counts;
    log?: (line: string) => void;
  },
): Promise<void> {
  const log = ctx.log ?? runtime.log;
  let itemId = ctx.itemId;
  if (!itemId) {
    if (ctx.apply) {
      itemId = await ctx.io.add(issue);
      log(`added ${issue.repo}#${issue.number}`);
    } else {
      // Keep going: the dry run reports the fields a new item would get too.
      log(`would add ${issue.repo}#${issue.number}  ${issue.title}`);
    }
    ctx.counts.added++;
  }

  const current = ctx.current?.Status;
  // Never drag an item out of a status a person put it in.
  const wantedStatus =
    current === undefined || DERIVED_STATUSES.has(current)
      ? statusFor(issue, ctx.underReview.has(`${issue.repo}#${issue.number}`))
      : undefined;

  const assignments: { field: string; value: string | undefined }[] = [
    { field: "Priority", value: priorityFor(issue) },
    { field: "Track", value: trackFor(issue, ctx.membership) },
    { field: "Status", value: wantedStatus },
  ];
  for (const { field, value } of assignments) {
    if (!value) continue;
    // Skip a write that would change nothing: most runs find most fields
    // already right, and each write is an API call.
    if (ctx.current?.[field] === value) continue;
    const definition = ctx.fields.get(field);
    const option = definition?.options?.find((o) => o.name === value);
    if (!definition || !option) continue;
    const change = `${issue.repo}#${issue.number} ${field}: ${ctx.current?.[field] ?? "(unset)"} -> ${value}`;
    if (!ctx.apply) {
      log(`would set ${change}`);
      ctx.counts.edited++;
      continue;
    }
    await ctx.io.edit(itemId!, definition.id, option.id);
    log(`set ${change}`);
    ctx.counts.edited++;
  }
}

/** Items added and field values set, by one run. */
export interface Counts {
  added: number;
  edited: number;
}

/** A run's closing line. */
export function summaryLine(apply: boolean, counts: Counts): string {
  return `${apply ? "Applied" : "Dry run"}: ${counts.added} item(s) added, ${counts.edited} field value(s) set.`;
}

/**
 * One pass over a set of issues: clear the `blocked` labels whose blockers
 * have closed, then bring each issue's board item in line. The full sweep
 * and the per-event sync both run this, and a dry run and `--apply` differ
 * only in whether the writes happen.
 */
export async function sweep(
  issues: Issue[],
  ctx: {
    apply: boolean;
    tracker: BlockerIO;
    board: BoardIO;
    /** Each issue's board item and current values, keyed by issue URL. */
    items: Map<string, { itemId?: string; current?: Record<string, string | undefined> }>;
    fields: Map<string, ProjectField>;
    membership: Map<string, Set<string>>;
    underReview: Set<string>;
    counts: Counts;
    log?: (line: string) => void;
  },
): Promise<void> {
  const log = ctx.log ?? runtime.log;
  // Before Status is derived: an issue unblocked here is Ready in this run.
  const blockers = await reconcileBlocked(issues, ctx.tracker, ctx.apply, REPOS);
  for (const { issue, closed } of blockers.cleared) {
    log(
      `${ctx.apply ? "unblocked" : "would unblock"} ${issue.repo}#${issue.number}: ` +
        `every blocker is closed (${closed.join(", ")})`,
    );
  }
  for (const { issue, reason } of blockers.unverifiable) {
    log(`cannot verify blocked ${issue.repo}#${issue.number}: ${reason}`);
  }
  for (const issue of issues) {
    const item = ctx.items.get(issue.url);
    await syncItem(issue, {
      apply: ctx.apply,
      fields: ctx.fields,
      membership: ctx.membership,
      underReview: ctx.underReview,
      current: item?.current,
      itemId: item?.itemId,
      io: ctx.board,
      counts: ctx.counts,
      log,
    });
  }
}

/** `owner/repo#12` → its parts, or undefined for anything else. */
export function parseTarget(ref: string): { repo: string; number: number } | undefined {
  const match = ref.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  return match ? { repo: match[1], number: Number(match[2]) } : undefined;
}

/** The board repository a reference names, matched case-insensitively. */
export function boardRepo(repo: string): string | undefined {
  return REPOS.find((r) => r.toLowerCase() === repo.toLowerCase());
}

/** One issue as the sync needs it, read through REST (no GraphQL cost). */
async function readIssue(
  repo: string,
  number: number,
): Promise<(Issue & { state: string; isPullRequest: boolean; nodeId: string }) | undefined> {
  try {
    const raw = await gh(["api", `repos/${repo}/issues/${number}`]);
    const data = JSON.parse(raw) as {
      number: number; title: string; html_url: string; body?: string | null; state: string;
      labels: { name: string }[]; pull_request?: unknown; node_id: string;
    };
    return {
      number: data.number,
      title: data.title,
      url: data.html_url,
      body: data.body ?? "",
      labels: data.labels.map((label) => ({ name: label.name })),
      repo,
      state: data.state,
      isPullRequest: data.pull_request !== undefined,
      nodeId: data.node_id,
    };
  } catch {
    return undefined;
  }
}

/**
 * The board, its fields, and one issue's item on it, in a single GraphQL
 * query. The full sweep lists every item with every field, which costs
 * hundreds of points; this reads only what one issue needs.
 */
async function boardForIssue(
  nodeId: string,
): Promise<{
  project: Project;
  fields: ProjectField[];
  itemId?: string;
  current?: Record<string, string | undefined>;
}> {
  const query = `query($owner: String!, $node: ID!) {
    user(login: $owner) {
      projectsV2(first: 20) {
        nodes {
          id number title url
          fields(first: 50) {
            nodes {
              ... on ProjectV2FieldCommon { id name }
              ... on ProjectV2SingleSelectField { options { id name } }
            }
          }
        }
      }
    }
    node(id: $node) {
      ... on Issue {
        projectItems(first: 20) {
          nodes {
            id
            project { id }
            status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
            priority: fieldValueByName(name: "Priority") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
            track: fieldValueByName(name: "Track") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          }
        }
      }
    }
  }`;
  type Value = { name?: string } | null;
  const data = JSON.parse(
    await gh(["api", "graphql", "-f", `query=${query}`, "-F", `owner=${OWNER}`, "-F", `node=${nodeId}`]),
  ).data as {
    user: { projectsV2: { nodes: (Project & { title: string; fields: { nodes: ProjectField[] } })[] } };
    node: { projectItems?: { nodes: { id: string; project: { id: string }; status: Value; priority: Value; track: Value }[] } };
  };
  const project = data.user.projectsV2.nodes.find((p) => p.title === TITLE);
  if (!project) throw new Error(`project "${TITLE}" not found; run the full sync to create it`);
  const item = data.node.projectItems?.nodes.find((i) => i.project.id === project.id);
  return {
    project: { id: project.id, number: project.number, url: project.url },
    fields: project.fields.nodes.filter((field) => field.id),
    itemId: item?.id,
    current: item
      ? { Status: item.status?.name, Priority: item.priority?.name, Track: item.track?.name }
      : undefined,
  };
}

/** The board writes, through `gh`. */
function boardIO(project: Project): BoardIO {
  return {
    async add(issue) {
      const result = JSON.parse(
        await gh([
          "project", "item-add", String(project.number), "--owner", OWNER,
          "--url", issue.url, "--format", "json",
        ]),
      ) as { id: string };
      return result.id;
    },
    async edit(itemId, fieldId, optionId) {
      await gh([
        "project", "item-edit", "--id", itemId, "--project-id", project.id,
        "--field-id", fieldId, "--single-select-option-id", optionId,
      ]);
    },
  };
}

/**
 * The open `blocked` issues on the board that name `ref` as a blocker, as
 * `owner/repo#number`. Read through REST, so it costs no GraphQL points.
 */
export async function dependantsOf(ref: string): Promise<string[]> {
  const wanted = ref.toLowerCase();
  const found: string[] = [];
  for (const repo of REPOS) {
    const raw = await gh([
      "api", "--paginate", `repos/${repo}/issues?state=open&labels=blocked&per_page=100`,
      "--jq", ".[] | select(.pull_request | not) | {number, body} | @json",
    ]);
    for (const line of raw.split("\n").filter(Boolean)) {
      const { number, body } = JSON.parse(line) as { number: number; body: string | null };
      if (parseBlockers(body ?? "", repo).refs.some((r) => r.toLowerCase() === wanted)) {
        found.push(`${repo}#${number}`);
      }
    }
  }
  return found;
}

/**
 * Sync the issues one event touched: an issue itself, or the issues a PR
 * says it closes. Costs a few GraphQL points per issue instead of the full
 * sweep's hundreds, which is what lets it run on every event.
 */
async function syncTargets(refs: string[], apply: boolean): Promise<void> {
  const membership = await buildMembership();
  const counts: Counts = { added: 0, edited: 0 };
  const queue = [...refs];
  for (let i = 0; i < queue.length; i++) {
    const ref = queue[i];
    const target = parseTarget(ref);
    const repo = target && boardRepo(target.repo);
    if (!target || !repo) {
      runtime.log(`skip ${ref}: not an issue in the board's repositories`);
      continue;
    }
    const issue = await readIssue(repo, target.number);
    if (!issue || issue.isPullRequest) {
      runtime.log(`skip ${ref}: not an issue`);
      continue;
    }
    if (issue.state !== "open") {
      // Closing is the project's own "Item closed" workflow's to record. What
      // this run owes a closed issue is the issues it was blocking: sync those,
      // so a dependant is unblocked now rather than at the daily sweep.
      const dependants = (await dependantsOf(`${repo}#${issue.number}`)).filter((d) => !queue.includes(d));
      runtime.log(`skip ${ref}: closed${dependants.length ? `; syncing what it blocked: ${dependants.join(", ")}` : ""}`);
      queue.push(...dependants);
      continue;
    }
    const board = await boardForIssue(issue.nodeId);
    await sweep([issue], {
      apply,
      tracker: trackerIO,
      board: boardIO(board.project),
      items: new Map([[issue.url, { itemId: board.itemId, current: board.current }]]),
      fields: new Map(board.fields.map((field) => [field.name, field])),
      membership,
      // `Closes #N` names the issue's own repository, so only its PRs matter.
      underReview: await issuesUnderReview([repo]),
      counts,
    });
  }
  runtime.log(`\n${summaryLine(apply, counts)}`);
}

/**
 * The whole run, as a function of its arguments: returns the exit code.
 * `import.meta.main` below is the only caller that exits the process.
 */
export async function main(argv: string[]): Promise<number> {
  const apply = argv.includes("--apply");

  // `repo` does not imply `project`, and the failure without it is a raw
  // GraphQL scope error several frames down. `gh project` also resolves
  // `--owner` through a query that needs `read:org`, and without it fails
  // with "unknown owner type", which names neither the token nor the scope
  // (observed in CI with a `repo` + `project` PAT). Say both here instead.
  //
  // The scopes come from the API's own header for the token in use, not from
  // `gh auth status`: that prints every account, and its warning
  // "Missing required token scopes: 'read:org'" names the very scope it lacks.
  const scopes = scopesFromHeaders(await gh(["api", "--include", "user"]));
  const lacking = missingScopes(scopes);
  if (lacking.length > 0) {
    runtime.error(
      `The token is missing ${lacking.map((m) => `\`${m}\``).join(" and ")}. ` +
        "GitHub Projects needs `project`, and `gh project` needs `read:org` to resolve the owner.\n" +
        `Grant them, then re-run:\n\n  gh auth refresh -s ${lacking.join(",")}\n`,
    );
    return 1;
  }

  // `--issue owner/repo#N` syncs one issue; `--pr owner/repo#N` syncs the
  // issues that PR says it closes. Without either, the full sweep runs.
  const flag = (name: string) => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const issueRef = flag("--issue");
  const prRef = flag("--pr");
  if (issueRef !== undefined || prRef !== undefined) {
    let refs = issueRef !== undefined ? [issueRef] : [];
    if (prRef !== undefined) {
      const pr = parseTarget(prRef);
      const repo = pr && boardRepo(pr.repo);
      if (!pr || !repo) {
        runtime.log(`skip ${prRef}: not a pull request in the board's repositories`);
        return 0;
      }
      const body = await gh(["api", `repos/${repo}/pulls/${pr.number}`, "--jq", ".body // \"\""]);
      refs = [...refs, ...closingRefs(body, repo)];
    }
    await syncTargets(refs, apply);
    return 0;
  }

  const project = await ensureProject(apply);
  if (project.number === -1) {
    runtime.log("\nRe-run with --apply to create the project, then run again to seed it.");
    return 0;
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

  const items = await readBoard(project);

  const membership = await buildMembership();
  const issues = await openIssues();
  const underReview = await issuesUnderReview();

  const counts: Counts = { added: 0, edited: 0 };
  await sweep(issues, {
    apply,
    tracker: trackerIO,
    board: boardIO(project),
    items,
    fields: byName,
    membership,
    underReview,
    counts,
  });

  runtime.log(`\n${summaryLine(apply, counts)}`);
  if (!apply) {
    runtime.log(
      "To make these changes, trigger the sweep (about 520 GraphQL points):\n\n" +
        "  gh workflow run project-sync --repo schlessera/brain-kit",
    );
    return 0;
  }

  // Count what is on the BOARD, not what was asked for. The first real run of
  // this script reported 44 added and 31 landed: `item-add` returns before the
  // item is listable, so an add issued against a stale listing is a silent
  // no-op. Re-running fixes it, which is the point of the whole script being
  // idempotent — but only if it says so rather than claiming success.
  const onBoard = await readBoard(project);
  const missing = issues.filter((issue) => !onBoard.has(issue.url));
  if (missing.length > 0) {
    runtime.log(
      `\n${missing.length} issue(s) did not land. This is expected on a first run; ` +
        `run the script again and they will be picked up:\n` +
        missing.map((issue) => `  ${issue.repo}#${issue.number}`).join("\n"),
    );
  } else {
    runtime.log(`All ${issues.length} open issue(s) are on the board.`);
  }

  runtime.log(`
One thing this script does not do — finish it once, in the web UI:

  Views. Make these four:
       Board      — board layout, grouped by Status
       Roadmap    — roadmap layout on Target, grouped by Track
       Ready      — table, filter: status:Ready label:agent-ready, sorted by Priority
       Epics      — table, filter: label:epic

${project.url ?? `https://github.com/users/${OWNER}/projects/${project.number}`}`);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv));
