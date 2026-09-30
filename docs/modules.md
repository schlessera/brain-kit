# Modules

A **module** packages a domain workflow — its document types, its skills, and
optionally a CLI command — so you can turn a whole area of your life on with one
config entry. brain-kit ships first-party modules and a `/new-module`
skill for authoring your own.

## What a module is

A module is an npm package (or a local directory referenced by path) whose entry
default-exports a **manifest** via `defineModule()`. There is no plugin daemon
and no lifecycle beyond load-time registration.

A manifest is two-phase: static identity (`name`, `configSchema`), then a
`setup(config)` function that builds the module's **contribution** from the
user's already-validated config block. This is what lets a taxonomy dir follow
a configured directory instead of being a static literal.

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

## Enabling and disabling modules

Modules are enabled by their presence in `brain.config.ts` under `modules:` —
the config **is** the registry. A key is a package name or a local path; the
value is the module's config block.

```ts
modules: {
  "@schlessera/brain-module-speaking": {},
  "@schlessera/brain-module-finance":  { clientsDir: "clients", feeTolerance: 30 },
}
```

The `/brain-module` skill does this conversationally: it lists available modules,
and enabling one creates its directories and `_index.md` files, adds the config
entry, regenerates the marked sections of your `CLAUDE.md`, and notes that a
hosting container's cron picks it up on next deploy. **Disabling flips the config
entry off and never deletes content** — because config is the state, it is
idempotent by construction.

## First-party modules

### `@schlessera/brain-module-jobs`

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

Image generation and editing, routed between OpenAI and Google image models by
capability rather than by a configured favourite.

- **Types contributed:** none. Generated images are assets that belong wherever
  the thing they illustrate lives; the module owns no directory.
- **Config:** `imagesDir` (fallback output directory, default `assets/images`),
  `disabledModels` (hide a model even when its provider has a key — useful to
  keep an expensive tier out of reach, or to drop one the account cannot use).
- **Environment:** `OPENAI_API_KEY` and/or `GEMINI_API_KEY`. Neither is
  required; each unlocks its own models, and `brain image models` reports what
  is actually reachable. Some requests can only be served by one side — see the
  module README for the routing table. GPT-image models additionally require
  API Organization Verification on the OpenAI account.
- **Skills:** `image-gen` (pick the model, price the call, write the file).
- **CLI word:** `brain image` — `"<prompt>"` to generate, `models` to list what
  is available. `--aspect`/`--resolution` work on every model; `--ref`,
  `--mask`, `--transparent`, `--size` route by capability; `--dry-run` prices a
  decision without spending, `--draft` takes the cheapest model that fits.
- **Caveat:** every call costs money and the command says how much. Where
  nothing in the request settles which model to use, it stops and asks rather
  than guessing — there is no vendor benchmark for "nicer picture".

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
                           # and detects command/type/dir collisions
brain validate             # must be green
brain skills sync          # must pick the new skills up
```

`brain module lint` zod-validates the manifest, checks skill frontmatter, runs
the skill-lint rules, detects command/type/directory collisions, and verifies the
module's `configSchema` parses your config block. Write the module README to the
same structure the first-party modules use — they are the reference examples.

## See also

- [concepts.md](concepts.md) — the taxonomy model modules extend.
- [configuration.md](configuration.md) — the `modules` config key.
- [extending/README.md](extending/README.md) — modules vs. provider seams.
