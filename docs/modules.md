# Modules

A **module** packages a domain workflow — its document types, its skills, and
optionally a CLI command — so you can turn a whole area of your life on with one
config entry. brain-kit ships three first-party modules and a `/new-module`
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
    cron: [{ name: "scrape", schedule: "0 6 * * *", command: "jobs scrape --all --browser" }],
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
| `hygieneChecks` | `((ctx) => AuditIssue[])[]`                       | Extra checks surfaced by `brain audit`. `ctx` is `{ db, root, config }`.                              |
| `indexRules`    | `{ dirAnchors?: string[] }`                       | Directory anchor files (for `[[dir/]]` wiki-link resolution).                                         |
| `exclude`       | `{ segments?: string[] }`                         | Path segments the indexer should skip.                                                                |
| `cron`          | `{ name, schedule, command }[]`                   | Advisory schedules consumed by container entrypoints and `brain doctor`.                              |

Module commands receive `{ root, json, config, taxonomy }` — the module's own
validated config block and the fully-merged taxonomy — so they never re-load
`brain.config` themselves.

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
- **CLI word:** `brain jobs` — `scrape`, `score`, `triage`, `review`, `stats`,
  `scaffold <id>`, `show`, `open`, `decide`, `search`, `gc`. `scrape --browser`
  appends the headless-Chrome pass to the API pass; `--browser-only` runs just
  the former.
- **Cron:** advisory `scrape` daily at 06:00, unified across both passes.
- **Caveat:** scraping may violate a board's Terms of Service — review each
  board's ToS and `robots.txt`, keep volume low, and prefer official feeds. See
  the module README.

### `@schlessera/brain-module-speaking`

The speaking lifecycle: researching conferences, developing talk ideas,
submitting to CFPs, tracking outcomes, preparing talks, planning travel, and
wrapping up afterward. Content and skills only — no CLI command, no database.

- **Types contributed:** `talk` → `talks/`, `conference` → `conferences/`,
  `travel` → `travel/` (dir anchors `status.md`, `itinerary.md`, `outline.md`;
  excludes `alt-decks`, `versions`, `deck` from indexing).
- **Config:** `travelParty` — an array of `{ name, role?, requirementsDoc? }`
  members. `plan-travel` reads this instead of hardcoding names and builds a
  per-member requirements checklist from each member's optional `requirementsDoc`
  (accessibility, an assistance animal, a child, visas, dietary needs).
- **Skills:** `conference-research`, `talk-ideas`, `brainstorm-talks`,
  `new-submission`, `submission-outcome`, `talk-prep`, `plan-travel`,
  `conference-aftermath`. The aftermath skill ends in a *pluggable* publishing
  handoff — it uses a configured content workflow if you have one, otherwise
  writes a plain retrospective note.
- **CLI word:** none.

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
