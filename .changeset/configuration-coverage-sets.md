---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": minor
---

The turn journal stores each distinct set of untraced configuration inputs once instead of copying every path onto every turn (#3257). A brain with many untraced inputs, for example skills that use computed imports, no longer repeats the same list on every turn row. Turn summaries gain the optional `configurationCoverageSet`, the set's SHA-256 identity, present only when the set is nonempty. The new authenticated read `GET /api/journal/configuration-coverage` returns the brain's current set (hash, sorted paths, count, turn id and `observedAt`) from the most recent complete turn that took a configuration inventory, or `{ state: "unknown" }` when none has. The SDK exports the `ConfigurationCoverageRead` type. On first open the journal moves existing per-turn arrays into stored sets; coverage and details read the same before and after. A turn recorded before this release with an empty inventory now reads `unknown` instead of `complete`, because it cannot show that it took one. Details still list every untraced path.
