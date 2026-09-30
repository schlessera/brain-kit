# Modules

A **module** packages a domain workflow — its document types, its skills, and
optionally a CLI command — so you can turn a whole area of your life on with one
config entry. The first-party modules are listed below; `/new-module` helps
you author your own.

## What a module is

A module is an npm package (or a local directory referenced by path) whose entry
default-exports a **manifest** via `defineModule()`. There is no plugin daemon
and no lifecycle beyond load-time registration.

A manifest is two-phase: static identity (`name`, `configSchema`), then a
`setup(config)` function that builds the module's **contribution** from the
user's already-validated config block. This is what lets a taxonomy dir follow
a configured directory instead of being a static literal. This manifest
excerpt assumes a defined `configSchema` and a `./cli` command implementation;
see a first-party module's source for a complete package.

```ts
import { defineModule } from "@schlessera/brain";

export default defineModule({
  name: "jobs",
  configSchema,
  setup: (config) => ({
    taxonomy: { types: { opportunity: { dir: config.opportunitiesDir } } },
    commands: { jobs: () => import("./cli") },
    indexRules: { dirAnchors: ["status.md"] },
    cron: [{ name: "scrape", schedule: "0 6 * * *", command: "jobs scrape" }],
  }),
});
```

Manifest fields:

| Field          | Type       | Purpose                                                              |
| -------------- | ---------- | -------------------------------------------------------------------- |
| `name`         | `string`   | The module's short name. Required.                                   |
| `configSchema` | zod schema | Validates the user's config block. Load fails hard on a rejected block. |
| `setup`        | `(config) => Contribution` | Builds the contribution from the validated config. Required. |

Contribution fields (all optional; the returned object is schema-validated at
load, and unknown keys are load errors):

| Field           | Type                                             | Contributes                                                                                          |
| --------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `taxonomy`      | `{ types?, classifierHints?, assetTitleRules?, propagation? }` | Types, capture hints, and rules merged into the effective taxonomy.                     |
| `skills`        | `string`                                         | Path to the module's `skills/` directory (relative to the package root).                             |
| `commands`      | `Record<word, () => import(...)>`                | **One** namespaced top-level CLI word, lazily imported (e.g. `brain jobs …`).                         |
| `tools`         | `Record<localName, () => import(...)>`           | Lazy MCP tools served as `<module>_<localName>`; each wraps the same operation as its CLI subcommand. |
| `hygieneChecks` | `((ctx) => AuditIssue[])[]`                       | Extra checks surfaced by `brain audit` and counted in `brain maintain`'s audit step; a check that throws becomes one `module-hygiene` warning. `ctx` is `{ db, root, config }`, with `config` typed by your configSchema. |
| `indexRules`    | `{ dirAnchors?: string[] }`                       | Directory anchor files (for `[[dir/]]` wiki-link resolution).                                         |
| `exclude`       | `{ segments?: string[] }`                         | Path segments the indexer should skip.                                                                |
| `cron`          | `{ name, schedule, command }[]`                   | Advisory schedules consumed by container entrypoints and `brain doctor`.                              |

Module commands receive `{ root, json, config, taxonomy }` — the module's own
validated config block and the fully-merged taxonomy — so they never re-load
`brain.config` themselves.

`defineModule` threads the configSchema's parsed type end to end: `setup(config)`,
`ctx.config` in every command's `run()`, and `ctx.config` in every hygiene check
are all the schema's output type. No cast, no re-parse — the loader already
failed hard on an invalid block, so what arrives is the validated value with
defaults applied. A command that lives in its own file names the type once:

```ts
import type { CommandContext, CommandModule } from "@schlessera/brain";
import type { JobsConfig } from "./module.js";

const command: CommandModule<JobsConfig> = {
  summary: "…",
  async run(args, ctx) {
    ctx.config.boards; // typed string[] — straight off the schema
    return 0;
  },
};
export default command;
```

Modules that ignore config (or declare no configSchema) need none of this —
the parameter defaults to `unknown` and everything compiles as before.
`bun run lint` refuses `ctx.config as X` in first-party module sources
(`scripts/check-module-casts.ts`): the generic makes the cast unnecessary,
and a cast would hide the contract regressing back to `unknown`.

How the contribution merges into the taxonomy — collisions, ordering,
overrides — is covered in
[concepts.md](concepts.md#document-types-and-the-taxonomy-model).

## Authoring MCP tools

Declare a tool when an existing CLI operation needs to be reachable from an
MCP client without a shell. Keep its deterministic operation in one function
that both the CLI subcommand and tool call. Declare each tool explicitly;
CLI commands are not exported automatically.

```ts
// Inside defineModule({ name: "catalog", configSchema, setup: … })
setup: () => ({
  tools: { lookup: () => import("./mcp/lookup.js") },
}),
```

Core composes `catalog_lookup`. A module with tools uses a lowercase name
matching `^[a-z][a-z0-9-]{0,30}$`, and cannot be named `brain`. Local names
match `^[a-z][a-z0-9_]{0,31}$`. The full name is at most 64 characters and
cannot replace or shadow a core tool. Modules without tools retain their
existing naming rules.

Author the definition with `defineModuleTool`:

```ts
import { defineModuleTool } from "@schlessera/brain";
import type { ToolContext } from "@schlessera/brain";
import { z } from "zod";
import type { CatalogConfig } from "../module.js";
import { lookupCatalog } from "../operations.js";

export default defineModuleTool({
  description: "Look up catalog entries. limit defaults to 10 and permits at most 50 entries.",
  inputSchema: z.strictObject({
    query: z.string().describe("Text to find in the catalog"),
    limit: z.number().int().min(1).max(50).default(10).describe("Maximum entries to return"),
  }),
  outputSchema: z.strictObject({
    entries: z.array(z.strictObject({ title: z.string() })),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async run(input, ctx: ToolContext<CatalogConfig>) {
    return lookupCatalog(input, ctx);
  },
});
```

The helper infers `input` and the result from the schemas. `ToolContext<C>`
provides `root`, the owning module's validated `config`, the effective
`taxonomy` and the request's abort `signal`. Use that config directly, with no
cast or re-read. Both schemas must be strict zod 4 objects representable as
JSON Schema; every input needs a description. State defaults and result caps
in the tool's description, and enforce the cap in the shared operation.

`readOnlyHint` and `openWorldHint` are required. A writing tool also states
`destructiveHint`; `idempotentHint` and a title are optional. These are client
hints, not permission grants. Backend permissions are decided by tool name.

The module README must have a level-two `MCP tools` section naming every
canonical tool, with inputs, defaults, limits, result shape and compatibility
ownership. For example:

```md
## MCP tools

`catalog_lookup` accepts query and limit (default 10, maximum 50) and returns
{ entries: [{ title }] }. This read-only tool calls the same catalog lookup
operation as the CLI. The module owns this supported name and schema under
its documented versioning policy.
```

Run `brain module lint catalog --json` before shipping. Tool findings use
`tool-load` for import/general definition failures, `tool-name` for naming
errors, `tool-annotations` for required hints, `tool-schema` for invalid
schemas or undescribed inputs, and `tool-docs` for the README section.
Annotation and schema failures use their specific rule, so one defect does
not also produce a duplicate `tool-load` finding. A rejected name remains a
load error for normal commands and receives a `tool-name` diagnostic in lint.

`brain module list --json` includes each enabled module's declared canonical
`tools` in declaration order, or `[]`. Listing does not import definitions.
MCP startup uses the same definition validator as lint; one invalid
definition prevents every tool from that module from registering. Lint also
checks input descriptions and README coverage. See
[mcp.md](mcp.md#module-tools) for discovery and the fixed process lifecycle.

Each module owns the names, schemas and behavior of its supported tools.
First-party tools enter the integration contract and follow the project's
versioning rules; third-party modules document the same policy in their own
packages. Namespacing prevents collisions and does not exempt a tool from
compatibility. The authoring exports are experimental until 1.0. See the
[module-tool decision](decisions/module-mcp-tools.md#8-compatibility-who-owes-what).

## Enabling and disabling modules

Modules are enabled by their presence in `brain.config.ts` under `modules:` —
the config **is** the registry. A key is a package name or a local path; the
value is the module's config block.

Install a package before enabling it, for example `bun add
@schlessera/brain-module-speaking`. Keep first-party module versions aligned
with your installed `@schlessera/brain` release. A local module must exist at
the configured path. After a manual config edit, run `brain config check` and
`brain skills sync`.

```ts
modules: {
  "@schlessera/brain-module-speaking": {},
  "@schlessera/brain-module-finance":  { clientsDir: "clients", feeTolerance: 30 },
}
```

The `/brain-module` skill does this conversationally: it lists available modules,
and enabling one creates its directories and `_index.md` files, adds the config
entry, regenerates the marked sections of your `CLAUDE.md`, and notes that a
hosting container's cron picks it up on next deploy. **Disabling removes the
config entry and never deletes content** — because config is the state, it is
idempotent by construction.

## First-party modules

This list follows `main`. Travel and module-contributed MCP tools join the
next release (0.40.0); they are absent from published 0.39.0. Speaking's travel
ownership changes with that release, so use the linked migration guide when
upgrading rather than copying a new config into an older install.

### `@schlessera/brain-module-jobs`

Full reference: [jobs package](../packages/module-jobs/README.md).

A personal job-search pipeline: it scrapes remote-job boards, deduplicates and
full-text-indexes postings in its own SQLite database (`jobs.db`), scores each
against criteria you define, and gives you a CLI to triage and scaffold
opportunity notes.

- **Types contributed:** `opportunity` → `career/opportunities/` (dir anchor
  `status.md`).
- **Config:** `criteria` (required — path to a scoring-criteria markdown file
  whose frontmatter defines weighted, named scoring groups), `opportunitiesDir`,
  `boards`, `queries`, `dbPath`. Scoring is *not* hard-coded — it is driven by
  the criteria file, which stays brain content you own and tune.
- **Skills:** `jobs-review` (triage the scraped queue in dialogue),
  `research-opportunity` (turn a listing into a tracked opportunity with a fit
  assessment), `interview-scheduled` (record a booked interview and sync the
  four places that have to agree about it).
- **Pipeline fields:** an opportunity's `status.md` records where it stands in
  frontmatter: `stage` (`researching` → `applied` → `screening` →
  `interviewing` → `offer`, or `closed`), `fit` (`strong`/`medium`/`weak`),
  `applied` (date), `next_step`, whose date goes in the core `deadline`, and
  `closed_reason`. Closing also sets `relevance: historical`. `brain jobs
  pipeline` gives the opportunities' `_index.md` a registry spec (an Active and
  a Closed table by `stage`), after which `brain registry` and `brain maintain`
  keep it current. Two audit checks (`jobs-stage`, info) flag a `status.md`
  without a `stage` and one still `researching` after 60 days.
- **CLI word:** `brain jobs` — `scrape`, `score`, `triage`, `review`, `stats`,
  `scaffold <id>`, `pipeline`, `show`, `open`, `decide`, `search`, `gc`. `scrape --browser`
  adds browser boards to the configured selection; `--browser-only` selects
  only browser boards. Selected adapters receive Chrome automatically.
- **Cron:** advisory `scrape` daily at 06:00 runs plain `jobs scrape`, following
  the same effective module settings as a manual run without adding boards.
- **Caveat:** scraping may violate a board's Terms of Service — review each
  board's ToS and `robots.txt`, keep volume low, and prefer official feeds. See
  the module README.

### `@schlessera/brain-module-speaking`

Full reference: [speaking package](../packages/module-speaking/README.md).

The speaking lifecycle: researching conferences, developing talk ideas,
submitting to CFPs, tracking outcomes, preparing talks and wrapping up afterward.

- **Types contributed:** `talk` → `talks/`, `conference` → `conferences/`.
  Shared anchors `status.md`, `itinerary.md`, `outline.md` remain; slide-deck
  segments `alt-decks`, `versions`, `deck` remain excluded.
- **Config:** an empty block for new users. Deprecated `travelParty` remains
  accepted during the travel transition, with an actionable warning when nonempty.
- **Skills:** `conference-research`, `talk-ideas`, `brainstorm-talks`,
  `new-submission`, `submission-outcome`, `talk-prep`, `conference-aftermath`.
  Speaking links to travel's planning capability and existing journey documents.
- **CLI word:** none.

### `@schlessera/brain-module-travel`

Standalone journeys, repeated day trips and visited places. The package joins
the next lockstep release. See its [README](../packages/module-travel/README.md)
for canonical formats and the complete upgrade path.

- **Types contributed:** `travel` → `travel/`, `trip` → `trips/`,
  `place` → `places/`; shared `status.md`, `itinerary.md`, `outline.md` anchors. Travel alone
  brings no conference types or slide-deck exclusions.
- **Config:** `travelParty`, an array of `{name, role?, requirementsDoc?}`;
  default `[]`. Existing paths and values move losslessly from speaking.
- **Skill:** `plan-travel`, for conference-linked and personal journeys.
- **CLI word:** `brain travel validate`, `brain travel migrate [--dry-run]`;
  both have documented `--json` envelopes.
- **Migration:** install/enable travel, preview/apply migration, restart and
  sync skills. Documents keep their paths, types, links and bytes. Conflicts
  and ambiguous TypeScript construction are reported without writes. Existing
  module settings JSON files require explicit review with the settings path.
- **History:** visit IDs belong to their canonical journey/trip document;
  place references deduplicate that pair. Unknown dates/coordinates remain
  unknown, and counts/date bounds derive from visits rather than stored totals.

### `@schlessera/brain-module-finance`

Full reference: [finance package](../packages/module-finance/README.md).

Accounts-receivable tracking for freelance/agency work. Per-client `ledger.md`
files are the source of truth; the module derives every balance, status, aging
bucket, and reconciliation warning from their frontmatter.

- **Types contributed:** `finance` → `clients/` (one sub-directory per client,
  each with a `ledger.md`).
- **Config:** `clientsDir`, `feeTolerance` (max per-invoice shortfall still
  treated as paid), `currency`, `termsDays`. The ledger frontmatter spec
  (invoices, payments, allocations, derived statuses) is documented in the module
  README, with an annotated starter at `templates/ledger.md`.
- **Skills:** none bundled.
- **CLI word:** `brain finance` — the AR report; `sync` (regenerate ledger tables
  and the `clients/_index.md` dashboard from frontmatter); `new-client <slug>`
  (scaffold a ledger from the template).
- **Hygiene check:** `ledger generated block out of date` — flags ledgers whose
  generated table lags behind their frontmatter, surfaced by `brain audit`.

### `@schlessera/brain-module-images`

Full reference: [images package](../packages/module-images/README.md).

Image generation and editing, routed between OpenAI and Google image models by
capability rather than by a configured favourite.

- **Types contributed:** none. Generated images are assets that belong wherever
  the thing they illustrate lives; the module owns no directory.
- **Config:** `imagesDir` (fallback output directory, default `assets/images`),
  `preferredModels` (tie-break order overriding the shipped routing policy),
  `disabledModels` (hide a model even when its provider has a key — useful to
  keep an expensive tier out of reach, or to drop one the account cannot use).
- **Environment:** `OPENAI_API_KEY` and/or `GEMINI_API_KEY`. Neither is
  required for listing the catalog; each admits its provider's candidates.
  A generation call still needs a usable key and the account's model access
  and quota. Some requests can only be served by one side — see the module
  README for the routing table.
- **Skills:** `image-gen` (pick the model, price the call, write the file).
- **CLI word:** `brain image` — `"<prompt>"` to generate, `models` to list what
  is available. `--aspect`/`--resolution` work on every model; `--ref`,
  `--mask`, `--transparent`, `--size` route by capability; `--dry-run` prices a
  decision without spending, `--draft` takes the cheapest model that fits.
- **Caveat:** generation uses provider billing. Capability filters run first;
  where several models fit, configured preferences and the documented shipped
  policy choose the model. `--dry-run` shows the choice without generating.
  A displayed cost is an estimate where the provider's billing is not yet known.

## Local (path) modules

A module does not have to be published. Reference a directory in your own repo by
path and it loads the same way:

```ts
modules: {
  "./modules/catalog": { owners: ["your-org"] },
}
```

The path resolves relative to the brain root, and brain-kit imports
`./modules/catalog/module.ts`. This is the mechanism for personal, one-off
workflows that never need to be shared — they use exactly the same manifest API
as the first-party modules.

## Authoring a module

Run `/new-module` in your agent. It interviews the domain (which types and
directories it owns, which lifecycle moments deserve skills, whether a CLI word
is warranted), **collision-checks the effective taxonomy before scaffolding**,
then generates the package:

```text
modules/<name>/
  module.ts              # defineModule() manifest
  skills/<skill>/SKILL.md
  README.md
  tests/module.test.ts
```

and adds the `brain.config.ts` entry. Before declaring done it runs the quality
gates, chiefly:

```sh
brain module lint <name>   # validates the manifest, skill frontmatter, and config block,
                           # detects command/type/dir collisions, and checks MCP tools
brain validate             # must be green
brain skills sync          # must pick the new skills up
```

`brain module lint` zod-validates the manifest, checks skill frontmatter, runs
the skill-lint rules, detects command/type/directory collisions, and verifies the
module's `configSchema` parses your config block. Write the module README to the
same structure the first-party modules use — they are the reference examples.
If it declares tools, lint also validates their imports, definitions, names,
annotations, schemas, input descriptions and README coverage.

## See also

- [concepts.md](concepts.md) — the taxonomy model modules extend.
- [configuration.md](configuration.md) — the `modules` config key.
- [extending/README.md](extending/README.md) — modules vs. provider seams.
