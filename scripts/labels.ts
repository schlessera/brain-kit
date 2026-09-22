// The label taxonomy for the brain-kit issue tracker, and for the private
// `brain-ui` deployment-shell repo that shares its workflow.
//
// GitHub labels are flat: there is no hierarchy, so the CATEGORY is the prefix
// and the colour reinforces it. One colour per namespace — scanning an issue
// list should tell you "this is a ui-server feature at p2" from the colour
// blocks alone, before you read a word.
//
// Four namespaces and a flat meta set:
//
//   type:      what KIND of work this is. Exactly one per issue.
//   area:      which part of the system it lands in. One or more.
//   priority:  when it gets done. Exactly one, or none for an unsorted backlog
//              item.
//   needs:     what is blocking it, when the blocker is not another issue.
//   (meta)     everything else — epic, agent-ready, contract, security, …
//
// Workflow STATE (backlog / ready / in progress / done) deliberately has no
// labels: it lives in the project board's Status field, which is the one place
// that can be wrong. A label and a board column tracking the same fact drift
// within a week.
//
// Edit here, then `bun scripts/sync-labels.ts --repo <owner/name>`.
// `tests/labels.test.ts` guards the invariants this file's readers assume.

export interface LabelSpec {
  name: string;
  color: string;
  description: string;
}

/** One colour per namespace, so the prefix is legible before it is read. */
export const NAMESPACE_COLORS = {
  type: "1d76db",
  area: "5319e7",
  needs: "e99695",
} as const;

const type = (name: string, description: string): LabelSpec => ({
  name: `type: ${name}`,
  color: NAMESPACE_COLORS.type,
  description,
});

const area = (name: string, description: string): LabelSpec => ({
  name: `area: ${name}`,
  color: NAMESPACE_COLORS.area,
  description,
});

const needs = (name: string, description: string): LabelSpec => ({
  name: `needs: ${name}`,
  color: NAMESPACE_COLORS.needs,
  description,
});

/** What kind of work. Exactly one per issue. */
export const TYPE_LABELS: LabelSpec[] = [
  type("feat", "A new capability or a change in user-visible behaviour."),
  type("fix", "Something is broken and must behave the way it is documented."),
  type("refactor", "Structure changes; behaviour does not. No changeset-visible effect."),
  type("test", "Coverage, harness or proof work with no behaviour change."),
  type("docs", "Documentation only."),
  type("chore", "Tooling, CI, release plumbing, dependencies."),
  type("spike", "Time-boxed investigation. The deliverable is a written decision, not code."),
];

/**
 * Where it lands. Mirrors the package layout, because that is the unit a
 * changeset, a test suite and an agent's working set all share.
 */
export const KIT_AREA_LABELS: LabelSpec[] = [
  area("core", "packages/core: the brain CLI, indexer, hybrid search, config, taxonomy, skills."),
  area("mcp", "The stdio MCP server and its brain_* tools."),
  area("modules", "First-party content modules and the module seam."),
  area("ui-sdk", "Wire protocol, runtime schemas, the server and client SDK surfaces."),
  area("ui-server", "Hono app factory: turn coordinator, auth, session catalog, routes, cron."),
  area("ui-react", "React chat/files/voice components, stores, WebSocket transport."),
  area("ui-kit", "The presentational design kit: components, tokens, Storybook, visual baselines."),
  area("backends", "AgentBackend implementations and the seam they share."),
  area("render", "render-template and the network-denied puppeteer renderer."),
  area("scrape", "Polite HTTP, robots.txt, headless Chrome, site adapters."),
  area("template", "template/ and the brain-template starting point."),
  area("ci", "CI workflows, the gates they run, release scripts, packaging."),
  area("docs", "The docs/ tree and the README / AGENTS / CONTRIBUTING surfaces."),
];

/**
 * brain-template generates a brain: markdown, config, skills. No runtime of
 * its own, so its areas are the things a generated repository actually holds.
 */
export const TEMPLATE_AREA_LABELS: LabelSpec[] = [
  area("config", "brain.config.ts, the taxonomy it declares, and the environment contract."),
  area("skills", "The workflow skills a generated brain ships with."),
  area("onboarding", "/brain-init and the first-run path, from clone to first search."),
  area("ci", "CI workflows and the sync from brain-kit's template/ directory."),
  area("docs", "The README and whatever else a new user reads first."),
];

/**
 * The deployment shell's areas. Shared by the private instance and by the
 * hosting template extracted from it, because they are the same shape.
 */
export const UI_AREA_LABELS: LabelSpec[] = [
  area("container", "Dockerfile, supervisord, users and ownership, the image's toolchain."),
  area("deploy", "Compose files, the host, reverse proxying, TLS, backups."),
  area("shell", "The bin entry, entrypoint, branding, and the glue over the kit packages."),
  area("cron", "Scheduled jobs: the crontab, the environment file, the digest."),
  area("ci", "CI workflows, the gates they run, image builds."),
  area("docs", "The docs/ tree and the README / AGENTS / CONTRIBUTING surfaces."),
];

/**
 * When. Four levels, because three collapses into "now" and "not now" and five
 * is a lie told by a solo maintainer. An issue with no priority label is
 * unsorted, which is an honest state and not an error.
 */
export const PRIORITY_LABELS: LabelSpec[] = [
  {
    name: "priority: p0",
    color: "b60205",
    description: "Drop everything: a security hole, data loss, or a broken release.",
  },
  {
    name: "priority: p1",
    color: "d93f0b",
    description: "Scheduled into the current or next milestone.",
  },
  {
    name: "priority: p2",
    color: "fbca04",
    description: "Wanted, not scheduled. Pulled in when a milestone has room.",
  },
  {
    name: "priority: p3",
    color: "c2e0c6",
    description: "Someday. Needs a driving use case before it starts.",
  },
];

/** What is blocking it, when the blocker is not another issue. */
export const NEEDS_LABELS: LabelSpec[] = [
  needs("decision", "Blocked on a maintainer or designer ruling, not on code."),
  needs("design", "Blocked on a design drop or a visual answer."),
  needs("repro", "Blocked on a reproduction."),
  needs("use-case", "Deliberately parked until something real drives it."),
];

/** Everything that is not a namespace. */
export const META_LABELS: LabelSpec[] = [
  {
    name: "epic",
    color: "3e4b9e",
    description: "A tracking issue. The work lives in its sub-issues; this one is never coded directly.",
  },
  {
    name: "agent-ready",
    color: "0e8a16",
    description:
      "Context and acceptance criteria are complete enough for an agent to take this unattended.",
  },
  {
    name: "blocked",
    color: "000000",
    description: "Waiting on another issue or an upstream dependency. Say which in the body.",
  },
  {
    name: "contract",
    color: "d4c5f9",
    description:
      "Touches the integration contract: CONTRACT: commit, contract doc updated in the same commit.",
  },
  {
    name: "breaking",
    color: "b60205",
    description:
      "Breaks a published API or documented behaviour. Needs a maintainer ruling before code.",
  },
  {
    name: "security",
    color: "ee0701",
    description: "Auth, isolation, egress, secrets, or anything in the threat model.",
  },
  {
    name: "good first issue",
    color: "7057ff",
    description: "Small, well-bounded, and does not need the whole architecture in your head.",
  },
  {
    name: "help wanted",
    color: "008672",
    description: "The maintainer would like someone else to take this.",
  },
  {
    name: "question",
    color: "d876e3",
    description: "A question rather than a work item.",
  },
  {
    name: "duplicate",
    color: "cfd3d7",
    description: "Already tracked somewhere else. Link it and close.",
  },
  {
    name: "wontfix",
    color: "ffffff",
    description: "A deliberate no. The reason belongs in a closing comment.",
  },
];

const crossRepo = (other: string, description: string): LabelSpec => ({
  name: `upstream: ${other}`,
  color: "fef2c0",
  description,
});

/**
 * The two repos ship as one system, so a fair number of issues have a
 * counterpart in the other. The label is a pointer, never a place to restate
 * what the other issue says.
 */
export const KIT_CROSS_REPO_LABELS: LabelSpec[] = [
  crossRepo(
    "brain-ui",
    "Has a counterpart in the private deployment-shell repo. Deployment specifics live there, not here.",
  ),
];

export const UI_CROSS_REPO_LABELS: LabelSpec[] = [
  crossRepo("brain-kit", "Has a counterpart in the public brain-kit repo, which owns the behaviour."),
];

/**
 * GitHub's defaults, superseded by the `type:` namespace. `bug`, `enhancement`
 * and `documentation` each say what a `type:` label says, and a taxonomy with
 * two words for one thing gets both.
 */
export const OBSOLETE_LABELS = ["bug", "enhancement", "documentation", "invalid"];

export type RepoKind =
  | "brain-kit"
  | "brain-ui"
  | "brain-template"
  | "brain-hosting-template";

const AREAS: Record<RepoKind, LabelSpec[]> = {
  "brain-kit": KIT_AREA_LABELS,
  "brain-ui": UI_AREA_LABELS,
  "brain-template": TEMPLATE_AREA_LABELS,
  // The hosting template is the extraction of the private shell, so it
  // inherits the shell's vocabulary rather than inventing a parallel one.
  "brain-hosting-template": UI_AREA_LABELS,
};

/**
 * Every repository but brain-kit points back at it, because brain-kit owns the
 * behaviour and the other three are places it is deployed or generated from.
 */
const CROSS_REPO: Record<RepoKind, LabelSpec[]> = {
  "brain-kit": KIT_CROSS_REPO_LABELS,
  "brain-ui": UI_CROSS_REPO_LABELS,
  "brain-template": UI_CROSS_REPO_LABELS,
  "brain-hosting-template": UI_CROSS_REPO_LABELS,
};

export function labelsFor(repo: RepoKind): LabelSpec[] {
  return [
    ...TYPE_LABELS,
    ...AREAS[repo],
    ...PRIORITY_LABELS,
    ...NEEDS_LABELS,
    ...META_LABELS,
    ...CROSS_REPO[repo],
  ];
}
