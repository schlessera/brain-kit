# Supported configuration and module formats

This is the shared compatibility policy for inputs a user deliberately writes
or supplies: brain configuration, documented environment settings, per-module
JSON settings and canonical module content. Field references remain with their
owners. Their documented meaning, validation, precedence and migration rules
are part of the [integration contract](integration-contract.md), even when a
field is described in a linked module reference rather than repeated there.

The [decision](decisions/supported-inputs.md) records the maintainer's boundary.
This reference follows repository source; consult the installed package's
changelog for release availability.

## Compatibility and ownership

A supported input includes its accepted representation, units, interpretation,
validation and failure behavior, precedence over other sources, omission/default
behavior and promised preservation during edits or migration. A loader accepting
arbitrary data does not make every such value a supported format. Undocumented
implementation details are internal; an existing documented promise cannot be
withdrawn merely by relabeling it internal.

Apply the existing contract versioning rules: additions ship in a minor;
removing, renaming, retyping or changing the meaning of a supported input is a
break. Before 1.0 a break requires a prior maintainer ruling on its issue, the
`breaking` label and a minor changeset naming the break; from 1.0 it requires a
major. Contract changes use `CONTRACT:` and update the integration contract in
the same commit. An explicit migration explains what changes, preserves
unrelated source and data, and documents any refusal or manual recovery path.
Opening an editor or loading a configuration is not permission to migrate it.

Some omitted values deliberately select a curated policy, such as the jobs
[default-enabled boards](decisions/jobs-board-defaults.md) or images' documented
model selection. Such policies may evolve under their explicit owner policy;
they do not promise one permanent catalog. This is not a blanket exemption for
default changes. Assess each change against its documented promise, including
validation of explicit selections, opt-in behavior and any affected migration.
An explicit user value must retain its documented precedence.

Module authors own their domain schemas and canonical field references and link
them to this policy. They classify a proposed change before implementation.
The separately governed experimental module-authoring API does not make a user's
supported files experimental merely because a module reads them. Likewise the
published `ENV_VARS` descriptor API and the meanings of environment inputs are
separate compatibility questions; export curation does not waive input promises.

## Brain configuration

`brain.config.ts` default-exports its config object; `defineConfig` supplies
typing, while the loader validates at runtime. `brain.config.json` uses the same
schema and is read only when the TypeScript file is absent. The files are not
merged. TypeScript can carry provider/runner implementations; JSON cannot carry
functions. A missing file returns no user config, and `{}` is valid. An invalid
selected file fails rather than falling back to another file or to defaults.
Imports are process-cached: start a fresh process to reload TypeScript edits.

All top-level families are listed below. Their nested field types, constraints,
effective defaults and examples live in [configuration.md](configuration.md).
Omission preserves source omission; core effective defaults are applied by the
consumer rather than written into the user's file.

| Family | Supported fields and meaning | Omission and validation |
| --- | --- | --- |
| `profile` | `name`, `cliTitle`: cosmetic CLI identity. | Optional strings; strict object. |
| `taxonomy` | `types`, `dirAnchors`, `canonical`, `canonicalPolicy`, `propagation`, `facts`, `assetTitleRules`, `classifierHints`, `defaultStaleness`, `tags`. | Core defaults, then module contributions, then user overrides; field-specific merge rules in [concepts](concepts.md#document-types-and-the-taxonomy-model). Type names are validated strings, not a fixed union. |
| `exclude` | `dirs`, `files`, `segments`: indexing exclusions. | Adds to core/module exclusions; exact file paths cannot end in `/`. See [exclusions](decisions/exclusion-rules.md). |
| `geo` | Canonical service, eligibility, endpoint, cache and resource configuration. | Absent leaves new services disabled; strict shared schema and contained relative `cacheDir`. See [geo configuration](../packages/geo/README.md). |
| `embeddings` | `provider`, `model`, `apiKeyEnv`, `dimensions`. | Omitted block resolves the Gemini built-in; missing key leaves vector search unavailable. A present block requires `provider`; dimensions are positive integers. |
| `completions` | `provider`, `fallback`, `apiKeyEnv`, `fallbackApiKeyEnv`. | Omitted block resolves the Gemini Flash built-in; a present block requires `provider`. Fallback is used when primary throws. Explicit key-variable names are nonempty strings. |
| `agentRunner` | Built-in name or passed-in runner. | Claude by default; registry resolution rejects unknown names. |
| `reranker` | `enabled`, `provider`, `model`, `apiKeyEnv`, `exclude`, `timeoutMs`, `depth`, `skipMargin`. | Model judgment is off unless `enabled: true`; credentials and mode overrides cannot enable it. Positive integer timeout, depth at least two, nonnegative margin. See [activation](decisions/reranker-activation.md). |
| `graph` | `root`: document from which graph distances are measured. | Root defaults to `AGENTS.md`, then `CLAUDE.md`; contained relative path. This does not enable a search-ranking boost. |
| `skills` | `emitters`: extra skill emitters. | Claude always runs; extras are optional string names. |
| `stats` | `coverageFloor`, `brokenLinkCeiling`: health warning ratios. | Defaults 0.9 and 0.05; values in 0–1. |
| `media` | `maxTrackedBytes`, `track`, `ignore`: sync/doctor media policy. | Defaults 5 MiB and empty lists; positive integer byte limit and nonempty glob strings. |
| `hooks` | `embedOnCommit`: background paid enrichment opt-in. | Off by default; boolean only. |
| `search` | `language`: full-text tokenizer and stopwords. | `english` by default, or `none`; changing it rebuilds FTS without re-embedding. |
| `instructions` | `maxTokens`: doctor instruction-weight warning budget. | 8000 estimated tokens; positive integer. |
| `sync` | `pull`, `judge`: pull strategy and bounded judgments. | See [sync defaults](configuration.md#sync); enums `rebase`/`merge` and `jev`/`off`. Missing judgment credentials use conservative decisions. |
| `modules` | Package name or `./` local module path → domain config, with core-owned `enabled`. | Config order is load order; keys must be package specifiers or contained relative paths. Domain validation belongs to each manifest. `enabled` defaults true and must be boolean. |

Core objects reject unknown fields. Path constraints apply where the schema uses
the repository-relative path validator: no absolute/home/backslash forms, `..`
segments or control characters. Do not generalize this to every string field:
for example `travelParty[].requirementsDoc` is presently an optional string.
Taxonomy constraints and downstream checks remain as documented in their owners.

Root selection is explicit argument → `BRAIN_ROOT` → nearest ancestor containing
a config file → nearest ancestor containing `.git` → current directory. Environment
does not generically overwrite brain-config keys: only the documented overrides
do, such as CLI `--rerank` → `BRAIN_RERANK_MODE` → configured reranker mode,
all subject to the persistent activation gate.

## Environment inputs

The package-owned references below contain the literal-variable inventory,
meaning, omission behavior and conditional requirements. The inventory includes
platform inputs and test controls so they can be classified rather than silently
promoted into new product promises. Packages with no environment reader add no
separate environment format. These references are generated from each package's
`src/config/env.ts`; the resolver and actual consumer determine parsing and
effective validation. Documented product controls below are supported inputs.
Platform location inputs, build metadata and the internal `NODE_ENV` test control
are classified separately in the precedence boundaries below; the table does not
promote ambient SDK variables to supported inputs.

| Owner reference | Declared literal names |
| --- | --- |
| [core](../packages/core/README.md#environment) | `BRAIN_ROOT`, `BRAIN_RERANK_MODE`, `XDG_BIN_HOME`, `NO_COLOR`, `BRAIN_CHROME_NO_SANDBOX`, `BRAIN_UI_CHROME_NO_SANDBOX`, `CLAUDE_CODE_PATH`, `GEMINI_API_KEY`, `TYPESAFE_API_KEY`, `ANTHROPIC_API_KEY` |
| [module-images](../packages/module-images/README.md#environment) | `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENAI_BASE_URL`, `GEMINI_BASE_URL` |
| [module-jobs](../packages/module-jobs/README.md#environment) | `CHROME_CDP_URL` |
| [scrape](../packages/scrape/README.md#configuration) | `SCRAPE_USER_AGENT`, `SCRAPE_CHROME_URL`, `SCRAPE_CHROME_PATH`, `SCRAPE_CHROME_NO_SANDBOX`, `SCRAPE_RESPECT_ROBOTS` |
| [ui-backend-claude](../packages/ui-backend-claude/README.md#environment) | `BRAIN_UI_EXEC_WRAPPER`, `BRAIN_UI_EXEC_KILLER`, `BRAIN_UI_SUBPROCESS_ENV_EXTRA`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `BRAIN_UI_REVERSE_GEOCODE`, `NOMINATIM_PUBLIC_SERVICE_ELIGIBLE`, `NOMINATIM_URL`, `NOMINATIM_USER_AGENT` |
| [ui-backend-pi](../packages/ui-backend-pi/README.md#environment) | `BRAIN_UI_EXEC_WRAPPER`, `BRAIN_UI_EXEC_KILLER`, `BRAIN_UI_SUBPROCESS_ENV_EXTRA`, `GEMINI_API_KEY`, `BRAIN_UI_REVERSE_GEOCODE`, `NOMINATIM_PUBLIC_SERVICE_ELIGIBLE`, `NOMINATIM_URL`, `NOMINATIM_USER_AGENT` |
| [ui-render-puppeteer](../packages/ui-render-puppeteer/README.md#environment) | `PUPPETEER_EXECUTABLE_PATH`, `BRAIN_UI_CHROME_PATH` |
| [ui-server](../packages/ui-server/README.md#environment) | `BRAIN_UI_AUTONOMOUS_SPEND_USD_PER_DAY`, `BRAIN_UI_AUTONOMOUS_TURNS_PER_DAY`, `BRAIN_UI_AUTONOMOUS_EMERGENCY_SPEND_USD`, `BRAIN_UI_AUTONOMOUS_EMERGENCY_TURNS`, `BRAIN_UI_AUTONOMOUS_TIMEZONE`, `BRAIN_UI_AUTONOMOUS_UNPRICED_USD_PER_TOKEN`, `BRAIN_UI_ASK_USER_FORM_MAX_DEPTH`, `BRAIN_UI_ASK_USER_FORM_MAX_NODES`, `BRAIN_UI_ASK_USER_FORM_MAX_OPTIONS`, `BRAIN_UI_EXEC_KILLER`, `BRAIN_UI_EXEC_WRAPPER`, `BRAIN_PATH`, `HOME`, `BRAIN_UI_CRON_HYGIENE`, `BRAIN_UI_SUBPROCESS_ENV_EXTRA`, `PI_CODING_AGENT_DIR`, `XDG_CONFIG_HOME`, `BRAIN_UI_SKILLS_GITHUB_TOKEN`, `GITHUB_TOKEN`, `DB_PATH`, `HOST`, `BRAIN_UI_INBOX_POKE_TOKEN_FILE`, `MAX_AUTONOMOUS_RUNS`, `BRAIN_UI_AUTONOMOUS_YIELD_AFTER_MS`, `BRAIN_UI_CONFIRM_BASH`, `BRAIN_UI_WS_MAX_CONNECTIONS`, `BRAIN_UI_WS_RATE`, `BRAIN_UI_WS_BURST`, `BRAIN_UI_LOG_LEVEL`, `SOURCE_COMMIT`, `ALLOWED_ORIGINS`, `MAX_CONCURRENT_SESSIONS`, `BRAIN_UI_TURN_TIMEOUT_MS`, `AUTH_MODE`, `BRAIN_UI_PASSWORD_HASH`, `COOKIE_SECRET`, `TRUST_PROXY`, `TRUST_PROXY_HOPS`, `PROXY_AUTH_HEADER`, `BRAIN_UI_DANGEROUSLY_DISABLE_AUTH`, `BRAIN_UI_ALLOW_PASSWORD`, `WEBAUTHN_RP_NAME`, `WEBAUTHN_USER_NAME`, `WEBAUTHN_USER_ID`, `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGINS`, `BRAIN_UI_ALLOW_LOOPBACK_ORIGIN`, `AGENT_BACKEND`, `TYPESAFE_API_KEY`, `CLAUDE_CODE_PATH`, `BRAIN_UI_CLAUDE_DEFAULT_MODEL`, `BRAIN_UI_CLAUDE_DEFAULT_THINKING_LEVEL`, `BRAIN_UI_CLAUDE_PROFILES`, `BRAIN_UI_PI_PROFILES`, `CLAUDE_CODE_OAUTH_TOKEN`, `BRAIN_UI_CLAUDE_TOKEN_MINTED_AT`, `ANTHROPIC_API_KEY`, `BRAIN_UI_MODEL_DISCOVERY`, `BRAIN_UI_MODEL_TTL_HOURS`, `BRAIN_UI_PRICING_DISCOVERY`, `BRAIN_UI_PRICING_TTL_HOURS`, `NODE_ENV`, `DEEPGRAM_API_KEY`, `VOICE_PROVIDER`, `VOICE_KEYTERM_LIMIT`, `VOICE_CACHE_DIR`, `BRAIN_UI_COASTLINE`, `OVERPASS_URL`, `OVERPASS_USER_AGENT`, `COASTLINE_CACHE_DIR`, `BRAIN_GEO_CONFIG_JSON` |

Static secrets and names selected by config are read when needed. Server factory
configuration is resolved when the app is created; it is not a promise of live
reload. Presence checks do not prove provider access, quota or request success.
Token-valued flags use trimmed, case-insensitive `1/true/on/yes` and
`0/false/off/no`; unknown or empty tokens use the declared fallback. `NO_COLOR`
uses nonempty presence instead: `NO_COLOR=0` still suppresses color. The installed
shell hooks' `BRAIN_SKIP_HOOKS` bypass is specifically `=1`.

Validation is input-specific, not a universal reject-on-invalid rule. The server's
autonomous budgets, form limits and canonical geo JSON reject invalid inputs;
some numeric settings and log severity use documented safe fallbacks. Profile
JSON and confirmation patterns have their own validation at backend initialization.
Read the owning [server reference](../packages/ui-server/README.md),
[hosting configuration](hosting/README.md) and [budget reference](inbox-budget.md)
before relying on a fallback. Authentication defaults and conditional secret
requirements remain governed by the hosting/auth validation; optional descriptor
entries do not authorize an invalid authentication setup.

Important precedence boundaries:

- `SCRAPE_CHROME_URL` wins over jobs' retained `CHROME_CDP_URL` alias. With no
  endpoint the shared scraper can launch its own browser; the alias is not a
  promise that every scrape connects to a fixed local endpoint.
- Renderer executable selection checks `PUPPETEER_EXECUTABLE_PATH`, then
  `BRAIN_UI_CHROME_PATH`, then known system paths. Core accepts either no-sandbox
  spelling through its token parser; the Puppeteer adapter receives that option.
- Inference profiles' declared credentials/base URLs override inherited defaults;
  profiles without their own credential retain the documented Claude subscription
  routing and API-key clearing. Model-discovery authentication is a separate use.
- Pi settings location is `PI_CODING_AGENT_DIR` → `XDG_CONFIG_HOME/pi` →
  `HOME/.pi`. Specialized skill-install token precedes `GITHUB_TOKEN`.
- `BRAIN_GEO_CONFIG_JSON` supplies canonical geo settings over legacy Overpass
  configuration; `BRAIN_UI_COASTLINE=false` still prevents those requests.
- `HOME` and XDG variables are platform location inputs. `SOURCE_COMMIT` is
  build-provided status metadata. `NODE_ENV=test` controls discovery defaults,
  not security. Inherited `PATH`, SDK/platform variables and arbitrary extra
  variable contents are not all brain-kit configuration APIs.

### Dynamically named families

Literal tables cannot enumerate these supported name sources and transport
boundaries. This inventory follows the current readers and the package-owned dynamic-family
metadata. Supported name sources remain distinct from internal transport snapshots.

| Owner and name source | Meaning and boundary |
| --- | --- |
| Core `embeddings.apiKeyEnv`, `completions.apiKeyEnv`, `completions.fallbackApiKeyEnv`, `reranker.apiKeyEnv` | Select built-in provider credential names at call time; omission uses that provider's default name. Primary and fallback are independent. |
| Images provider catalog `apiKeyEnv` | Provider-declared credential lookup; current OpenAI/Gemini names are in the literal table. This does not introduce a provider-registration seam. |
| Claude inference-profile `authTokenEnv` / `apiKeyEnv` | Query-time credential and availability lookup; values are not config-file secrets. The profile authentication rules still apply. |
| UI server and pi `WEB_SEARCH_PROVIDERS[].envVar` | Catalog-selected key-presence checks for environment-configured web-search providers. Presence is returned, not secret values or copied settings. |
| Pi brain-config `embeddings.apiKeyEnv` | Call-time key-presence check for the selected embedding provider. |
| Core `inheritedEnv(overrides)` | Call-time ambient snapshot with explicit overrides last; an internal subprocess transport, not a promise for every ambient variable. |
| UI server `subprocessEnv(audience, extra, extraNames)` | Audience allowlist plus admitted operator/declared names; explicit overrides last. `BRAIN_UI_SUBPROCESS_ENV_EXTRA` is a supported comma-separated admission control, trimmed/validated and itself withheld. |
| Claude/pi filtered subprocess environments | Existing agent allowlist and operator extras; Claude also admits selected-profile credential names and applies its profile overrides. Forwarding does not make unknown variable meanings part of this contract. |

The Google SDK's ambient `GOOGLE_API_KEY` is not a brain-kit credential-selection
input. The Gemini providers pass their selected key explicitly. No supported
promise requires mutating `GOOGLE_API_KEY` around asynchronous requests.

## Module settings and lifecycle

For lowercase module manifest names, `settings/<name>.json` is a canonical
JSON object. Its own keys merge recursively over the brain-config domain block;
arrays, scalars and `null` replace. The same manifest schema then validates and
applies defaults. Absent JSON contributes `{}`. Core-owned `enabled` is forbidden
there; enable/disable is a separate writer. Dormant modules retain domain loading
and validation. Invalid hand-edited JSON fails; it does not erase an override or
silently fall back. Settings paths cannot alias another path through symlinks.

The [module settings contract](integration-contract/package-api.md#module-settings-additive-528)
defines the shipped snapshot, provenance, opaque source revision, CLI and HTTP
writer. Load, validation, CLI saves and UI saves use the same domain schema.
Untouched optional fields stay absent; read-only/unsupported JSON values remain
preserved. TypeScript keeps logic, and ordinary settings saves do not rewrite it.
Inherited values require an explicit override; resetting removes the saved key.

Writes validate before replacing source, serialize revision checks and commit,
and reject stale revisions. A changed save commits only its owned JSON once;
structurally unchanged saves retain bytes and make no commit. Source subtrees
that did not change retain their representation. Failures restore prior target
files/index entries and preserve unrelated staged work. These are preservation
promises, not a requirement to maintain a particular internal lock or hash layout.

Migration is an explicit reviewed transaction. Jobs previews the complete legacy
scoring source, proves equivalent parsed scoring and atomically moves known keys
to JSON, retaining casing, accepted source representations, unknown scoring keys,
unrelated frontmatter and prose. Legacy frontmatter remains a fallback until
migrated. JSON scoring wins when supplied; defaults are not materialized just
because an editor opens. Travel's source-only ownership migration remains a
different command: it refuses existing speaking/travel settings files, and its
manifest does not declare a shared settings migration planner. Such files require
reviewed manual migration, not an automatic invocation of a nonexistent planner.

## First-party module inventory

All five domain schemas are strict. Each reference below owns its field meanings,
validation, defaults and canonical formats under this shared policy. The shared
writer applies even when a module has no custom editor metadata.

| Module | Supported domain configuration | Canonical user content and owner reference |
| --- | --- | --- |
| Speaking | `travelParty` array of `{name, role?, requirementsDoc?}`, default `[]`; deprecated but retained during the explicit travel transition. | `talk` and `conference` Markdown, existing hubs and links; [speaking reference](../packages/module-speaking/README.md), common frontmatter and directory-anchor rules. User prose is canonical. |
| Travel | `travelParty` with the same member representation and default `[]`. | `travel`, `trip`, `place` Markdown; journey/trip-owned visit IDs, place references, route/track and photo assets. [Canonical formats](../packages/module-travel/README.md#canonical-formats) specify validation, relative references and unknown values. Dates/coordinates may remain unknown; titles/dates are not visit identity. |
| Finance | `clientsDir` default `clients`, numeric `feeTolerance` default 30, `currency` default `USD`, positive integer `termsDays` default 30. | [`ledger.md` frontmatter](../packages/module-finance/README.md#ledger-frontmatter-spec): client identity, invoices, payments and allocations are authoritative. Statuses, balances and owned generated tables are derived; surrounding prose is preserved. |
| Jobs | Required `criteria`; optional source-form `scoring`, `dbPath`, positive currency `rates`; `opportunitiesDir`, `boards`, `queries`, `enrichment.concurrency` and `enrichment.maxDetailPages` with schema defaults. | [Scoring/settings](../packages/module-jobs/README.md#scoring-settings), [criteria format](../packages/module-jobs/docs/criteria-template.md), opportunity `status.md` pipeline fields and registry spec. JSON scoring or legacy criteria frontmatter is canonical input. `jobs.db` also holds manual review decisions and notes. |
| Images | `imagesDir` default `assets/images`; optional `disabledModels` and ordered `preferredModels` string arrays. | [Images reference](../packages/module-images/README.md): generated image files kept at user-selected paths are content; catalog/routing details follow explicit selection policy. No additional canonical Markdown or JSON content schema is declared. |

Settings live at the manifest-name path, independent of a package key alias.
Core frontmatter, wiki links, registry declarations and generated-region markers
retain their [file-layer contracts](integration-contract/frontmatter.md#file-layer-contracts).
Module-specific Markdown fields augment those rules; they do not replace them.

## Storage that is not a user input format

`brain.db` is a disposable content index; rebuilding from canonical files may
replace it. Its existing separately documented query/direct-SQL compatibility
promises still bind their consumers. Committed context/asset sidecars and stats
history retain their existing file-layer contracts even though they are
machine-managed. Derived does not automatically mean uncontracted.

Internal cache layouts, transient scratch output and internal storage schemas
are not supported hand-authored input formats. Do not infer that an unclassified
module file can be deleted or regenerated. Jobs' database contains `review_status`,
`reviewed_at` and `review_notes` written by manual review: scraping/indexing cannot
reconstruct that state. UI operational storage likewise has its own backup and
recovery requirements. Those schemas can remain internal while their state must
be preserved. Canonical module Markdown, JSON settings and user-kept assets are
never disposable merely because they are outside the core content index.
