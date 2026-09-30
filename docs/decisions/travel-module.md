# Travel ownership and canonical visit history

## Decision — 2026-09-30

Travel is a content module alongside speaking, not a speaking feature. The
[ownership ruling](https://github.com/schlessera/brain-kit/issues/60#issuecomment-5869107262)
and [travel scope ruling](https://github.com/schlessera/brain-kit/issues/524#issuecomment-5869656145)
require overnight journeys, repeated day trips and visited places without
changing existing travel paths, type values, links or party settings.
The later [example-world ruling](https://github.com/schlessera/brain-kit/issues/566#issuecomment-5909879203)
uses Odysseus for new fixtures and documentation.

`travel` retains the existing journey meaning. `trip` is one canonical file
per repeatable route or place, with proposed/done/dismissed state and an
embedded visit history. `place` is a canonical country, city, town or spot.
A visit's identity is its owner's root-relative document path plus a stable
visit ID. Route labels identify variants inside one trip; one primary route
makes selection explicit. The parser checks those invariants
(`parseTravelDocument`, `packages/module-travel/src/content.ts:78-97`).

Place summaries union references from the place and from canonical
journey/trip visits, deduplicating the document/visit pair. They never read
stored counts or dates as authority
(`summarizePlaceVisits`, `packages/module-travel/src/content.ts:178-201`).
Unknown dates and coordinates stay unknown. An undated visit still counts;
first/last bounds remain unknown if any included date is unknown. Valid
zero coordinates remain zero. Domain parsing uses YAML JSON scalars through the
cache-free frontmatter helper so timestamp coercion cannot turn a written
nonexistent date into another day. A failing fixture showed unquoted
`2026-02-30` becoming `2026-03-02` under the default timestamp parser. Relative assets must resolve within the brain,
and place ancestry and visit references must resolve in canonical files
(`readTravelCorpus`, `packages/module-travel/src/content.ts:105-167`).
Markdown remains authoritative; no travel database or geocoding is introduced.

## Migration boundary

Speaking retains talks and conferences. Both modules contribute the same
legacy directory anchors, so enabling travel alone preserves directory links
through `status.md`, `itinerary.md` and `outline.md`. Speaking's deck exclusions
stay in speaking. The journey planning skill moves with travel; conference
outcome and aftermath skills link to that owner rather than owning travel.

Migration is an explicit CLI source-edit job, not startup behavior. Speaking
accepts and warns about its deprecated nonempty party field until the user
moves it. `brain travel migrate` supports canonical package-keyed JSON blocks
and directly exported TypeScript literals. It copies the complete literal
value, removes only the legacy property and preserves unrelated source text.
Equal target values collapse safely; conflicts, duplicate keys, dynamic
values and ambiguous targets refuse without writing
(`planTravelConfigMigration`, `packages/module-travel/src/migration.ts:97-146`).
The TypeScript compiler is loaded only for this job: its AST identifies syntax
without executing or serializing configuration logic. Symlinked config files
are refused and successful writes use the existing atomic writer.

[Module settings #528](https://github.com/schlessera/brain-kit/issues/528)
owns future per-module JSON precedence and the shared CLI/API writer. This
migration uses today's canonical config and refuses when either travel or
speaking already has a saved settings file; it never guesses that future
precedence. Normal commands continue using validated context configuration.
The approved pre-1.0 ownership break and upgrade instructions are recorded in
the [integration contract](../integration-contract.md#travel-ownership-and-canonical-content).

## Alternatives and evidence

Keeping travel in speaking would prevent a travel-only brain and duplicate
type ownership when both modules load. A real loader/taxonomy test failed at
the duplicate-type assertion with that old behavior; travel alone and both
modules now pass actual CLI module listing and linting. Real indexing and
validation also check all three legacy directory anchors.

One file per occurrence, or deduplicating by title/date, would fragment a
repeatable route and collapse distinct visits on identical or unknown dates.
The canonical fixture deliberately links one event more than once and stores
an incorrect display count; its summary still has one visit. A separate
fixture has two different known dates, then adds an undated visit, proving
both chronological bounds and the retained uncertainty.

Automatically rewriting config on load, reserializing evaluated TypeScript,
or choosing one conflicting party would risk unrelated settings or data.
Loadable old-behavior migration stubs failed assertions about nonempty party
preservation, conflicts and changed source. Real CLI tests apply JSON and TS
migrations, reload in a fresh process, verify content bytes and repeat the job
without another edit. Domain formats are checked by `brain travel validate`;
core validation keeps its existing common metadata and wiki-link contract,
without adding a validator extension seam.
