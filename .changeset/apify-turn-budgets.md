---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

The global turn, conversation and UTC-day budgets can now count admitted Apify liability (#3307). `createTurnBudgets` accepts an Apify ledger source, and `apifyBudgetSource` builds one from the shared ledger. With it, each receipt scope adds the ledger's liability to `costUsd` once and reports it in the new optional `apifyUsd`, so admission, mid-turn stops, relayed-provider refusals and the SDK backstop all see it. `TurnBudgetCoverage` gains a value that names Apify and one that says Apify accounting was unavailable, in which case its spend is not counted rather than read as zero. Without a ledger the receipt is unchanged. The turn budgets' new `inferenceSpend` reports inference without Apify's own liability, so Apify admission never counts it twice.
