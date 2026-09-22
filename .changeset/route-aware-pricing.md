---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
---

A run's effective cost is now priced by the route its inference actually took,
not by model id alone. The two pricing catalogs carry some of the same ids at
different rates — OpenRouter resells models their vendors also sell directly —
so a run that went straight to the vendor was being priced at OpenRouter's
resale rate whenever both catalogs listed its model. On
`deepseek/deepseek-chat`, live today, that overstates output cost by 2.1x.

Backends now classify a profile's route (`classifyRoute`, beside
`classifyBilling`); it is resolved once at run start, rides the root span like
the billing mode, and selects the catalog inside the rollup. Nothing became
async: `resolve()` is still synchronous and still never touches the network.

Coverage does not narrow. A run whose route is unknown — everything recorded
before this change, or a profile behind a proxy no backend recognises — prices
exactly as it did before rather than going unpriced. A rate borrowed from the
catalog a run did not go through still prices the run, flagged as an estimate.
Unknown cost remains unknown and never renders as `$0`.
