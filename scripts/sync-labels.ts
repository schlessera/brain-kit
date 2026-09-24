// Push the label taxonomy in scripts/labels.ts to a GitHub repository.
//
//   bun scripts/sync-labels.ts                      # brain-kit, dry run report
//   bun scripts/sync-labels.ts --apply
//   bun scripts/sync-labels.ts --repo schlessera/brain-template --apply
//   bun scripts/sync-labels.ts --apply --prune      # also delete unknown labels
//
// Dry run is the default on purpose: deleting a label removes it from every
// issue that carries it, and there is no undo. `--prune` is opt-in on top of
// `--apply` for the same reason.
//
// This shells out to `gh` rather than talking to the API directly so it uses
// whatever auth the maintainer already has. It needs no scopes beyond `repo`.

import { labelsFor, OBSOLETE_LABELS, type LabelSpec, type RepoKind } from "./labels.ts";

const DEFAULT_REPO = "schlessera/brain-kit";

interface ExistingLabel {
  name: string;
  color: string;
  description: string;
}

// The three public repositories. No other repository is synced from here
// (#299).
const KNOWN: RepoKind[] = ["brain-kit", "brain-template", "brain-hosting-template"];

function repoKind(repo: string): RepoKind {
  const name = (repo.split("/").pop() ?? repo) as RepoKind;
  if (KNOWN.includes(name)) return name;
  throw new Error(
    `Unknown repository ${repo}: the taxonomy defines area labels for ${KNOWN.join(", ")}.`,
  );
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

async function listLabels(repo: string): Promise<ExistingLabel[]> {
  // --paginate, because a taxonomy this size passes GitHub's 30-per-page default.
  const raw = await gh(["api", "--paginate", `repos/${repo}/labels`]);
  // `--paginate` concatenates JSON arrays, so parse defensively rather than
  // assuming one document.
  const documents = raw.replace(/\]\s*\[/g, ",").trim();
  return documents ? (JSON.parse(documents) as ExistingLabel[]) : [];
}

type Action =
  | { kind: "create"; label: LabelSpec }
  | { kind: "update"; label: LabelSpec; from: ExistingLabel }
  | { kind: "delete"; name: string; reason: "obsolete" | "unknown" };

export function planActions(
  wanted: LabelSpec[],
  existing: ExistingLabel[],
  options: { prune: boolean },
): Action[] {
  const byName = new Map(existing.map((label) => [label.name, label]));
  const wantedNames = new Set(wanted.map((label) => label.name));
  const actions: Action[] = [];

  for (const label of wanted) {
    const current = byName.get(label.name);
    if (!current) {
      actions.push({ kind: "create", label });
      continue;
    }
    const drifted =
      current.color.toLowerCase() !== label.color.toLowerCase() ||
      (current.description ?? "") !== label.description;
    if (drifted) actions.push({ kind: "update", label, from: current });
  }

  for (const name of OBSOLETE_LABELS) {
    if (byName.has(name) && !wantedNames.has(name)) {
      actions.push({ kind: "delete", name, reason: "obsolete" });
    }
  }

  if (options.prune) {
    for (const label of existing) {
      if (wantedNames.has(label.name)) continue;
      if (OBSOLETE_LABELS.includes(label.name)) continue;
      actions.push({ kind: "delete", name: label.name, reason: "unknown" });
    }
  }

  return actions;
}

function describe(action: Action): string {
  switch (action.kind) {
    case "create":
      return `create  ${action.label.name}`;
    case "update":
      return `update  ${action.label.name}  (#${action.from.color} → #${action.label.color})`;
    case "delete":
      return `delete  ${action.name}  (${action.reason})`;
  }
}

async function apply(repo: string, action: Action): Promise<void> {
  switch (action.kind) {
    case "create":
      await gh([
        "label",
        "create",
        action.label.name,
        "--repo",
        repo,
        "--color",
        action.label.color,
        "--description",
        action.label.description,
      ]);
      return;
    case "update":
      await gh([
        "label",
        "edit",
        action.label.name,
        "--repo",
        repo,
        "--color",
        action.label.color,
        "--description",
        action.label.description,
      ]);
      return;
    case "delete":
      await gh(["label", "delete", action.name, "--repo", repo, "--yes"]);
      return;
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const repo = argv.includes("--repo") ? argv[argv.indexOf("--repo") + 1] : DEFAULT_REPO;
  const shouldApply = argv.includes("--apply");
  const prune = argv.includes("--prune");

  const wanted = labelsFor(repoKind(repo));
  const existing = await listLabels(repo);
  const actions = planActions(wanted, existing, { prune });

  if (actions.length === 0) {
    console.log(`${repo}: ${wanted.length} labels, already in sync.`);
    process.exit(0);
  }

  console.log(`${repo}: ${actions.length} change(s)${shouldApply ? "" : " — dry run"}`);
  for (const action of actions) console.log(`  ${describe(action)}`);

  if (!shouldApply) {
    console.log("\nRe-run with --apply to make these changes.");
    process.exit(0);
  }

  for (const action of actions) {
    await apply(repo, action);
  }
  console.log(`\nApplied. ${repo} now carries ${wanted.length} labels.`);
}
