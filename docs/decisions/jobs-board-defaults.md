# Jobs board defaults follow the board declarations

**Decided 2026-09-28 by the maintainer**, on
[#186](https://github.com/schlessera/brain-kit/issues/186), using the shared
per-module JSON settings delivered by
[#528](https://github.com/schlessera/brain-kit/issues/528).

An omitted selection means the curated default-enabled boards: `remoteok`,
`weworkremotely`, `workingnomads` and `remotelyde`. Each board declares its own
on/off policy and any caveat in `packages/module-jobs/src/boards.ts`. That
declaration generates the schema default, settings choice descriptions and
scraper fallback. Adding a board means adding its declaration and adapter
factory; it requires no separate default list or settings UI edit.

The selection is curated rather than every registered adapter. The browser
boards need Chrome; SimplyHired has measured intermittent rate limiting;
Jobgether's allowed API path yields one page; Remotive's only API path is
disallowed. Their existing default-off policy remains unchanged. Selection
does not authorize bypassing robots.txt: the
[scraping politeness decision](scraping-politeness.md) still binds.

Core's shared settings loader applies brain config first, then own JSON keys
from `settings/jobs.json`, then validates the combined input with the original
module schema. Consequently an explicit TypeScript `boards` array replaces
the module defaults, an explicit JSON array replaces that TypeScript array,
and JSON without the key preserves the TypeScript selection. CLI commands
and the settings API use those same effective values. The direct scraper has
no brain configuration source; omitted `sources` uses the same curated policy.
Existing TypeScript is never automatically rewritten or migrated.

The previous schema supplied `["remoteok"]` even when the user supplied no
selection. CLI selection treated that as configured and scraped one board;
the direct scraper used the four-board fallback. A keyless regression observed
the one-element effective CLI settings array before the fix. Runtime fixtures
now exercise all four curated adapters through the actual CLI and direct
runner, and compare CLI/HTTP settings for omitted, TypeScript-only, JSON
replacement and JSON-without-boards cases. A separately loaded fixture module
adds a default-on and a default-off board to only its declaration and registry:
both become choices, and only the default-on board joins both scrape paths.

Alternatives rejected:

- Keep the RemoteOK-only schema default and add UI defaults. That preserves
  the disagreement and lets settings displays diverge from actual scraping.
- Point the schema at a manually maintained curated list beside separately
  declared settings choices. A new board can still miss its default policy.
- Add a jobs-specific settings loader or writer. Shared validation, precedence
  and editing already belong to #528; a second implementation would drift.
- Migrate existing TypeScript selections automatically. Explicit user choices
  remain authoritative until the user changes them.

**Strict selection, decided 2026-09-28 on
[#218](https://github.com/schlessera/brain-kit/issues/218):** an explicit empty
`boards` array intentionally selects nothing. JSON `boards: []` replaces a
nonempty TypeScript selection, and TypeScript `boards: []` replaces defaults.
An ordinary scrape reports “no boards selected”, succeeds and invokes no
adapters or network transports. Its existing JSON report has empty `sources`
and zero totals; it also leaves existing jobs unscored and undeduplicated.

Unknown or retired names reject the entire selection, even beside valid names.
The shared module schema validates both saves and hand-edited settings with
field-level diagnostics. Invalid saves preserve settings bytes and create no
commit. A retired name includes its retirement explanation and valid choices;
it never becomes a warning followed by a partial scrape or default fallback.
Invalid loaded settings can block other module commands until corrected. CLI
dispatch retains the settings error when the invalid module's namespace could
not be registered.

Positionals still override a valid configured selection, `--all` still selects
every board, and the browser selectors retain their existing behavior. These
manual selectors do not bypass invalid loaded settings. The contributed
schedule uses ordinary `jobs scrape` under
[#227](https://github.com/schlessera/brain-kit/issues/227), so it observes the
same validation and empty-selection semantics.

Keyless fixtures run the real CLI and contributed command, shared writer and
mounted settings HTTP route. They retain nonempty mixed invalid inputs and
nonempty TypeScript settings beneath an empty JSON override. Adapter and
transport observations distinguish rejection or intentional emptiness from a
silently filtered, partially executed or default-substituted run.
