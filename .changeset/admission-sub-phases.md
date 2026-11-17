---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

`ActivityTurnLifecycle` gains an optional `subPhases` array (#3355). Each entry times one named step of governed admission (`phase: "governed"`) or journal begin (`phase: "journal"`), with `startedAt`, `endedAt` and `elapsedMs`. Steps follow the existing phase rules: a step that never finished has a null `endedAt`, and on a terminal record its `elapsedMs` measures to the failure boundary. Step names are open vocabulary. Records written before this release have no `subPhases`.
