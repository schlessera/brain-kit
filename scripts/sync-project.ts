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
  Distribution: [{ epics: [26], also: [], repo: "schlessera/brain-kit" }],
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
    // Intent, never a commitment — it is what the roadmap layout positions on.
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
      "number,title,url,labels",
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

export function priorityFor(issue: { labels: { name: string }[] }): string | undefined {
  const label = issue.labels.find((l) => l.name.startsWith("priority: "));
  return label?.name.replace("priority: ", "").toUpperCase();
}

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

    const assignments: { field: string; value: string | undefined }[] = [
      { field: "Priority", value: priorityFor(issue) },
      { field: "Track", value: trackFor(issue, membership) },
    ];
    for (const { field, value } of assignments) {
      if (!value) continue;
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
