---
"@schlessera/brain-ui-server": minor
"@schlessera/brain": minor
---

- Added: per-package environment chokepoints with a runtime descriptor of every
  variable read, and generated env documentation in each package README.
- Added: `ui-server` exports a resolved `ServerConfig` and returns an app handle
  (`config`, `db`, `wsHost`, `isTurnActive`, `cancelActiveTurns`, `close`).
- Added: `openBrainDb`/`withBrainDb` gate every `brain.db` read on
  `schema_version`.
- Changed: `@schlessera/brain-backend-claude` is an optional peer of
  `ui-server`, not a dependency — a deployment must declare the backend it uses.
- Changed: the module contract carries the config generic through
  `CommandContext`, `HygieneContext` and `CommandModule`, so a module author no
  longer casts a value the loader already validated.
- Removed: `configureDb`, `getDb`, `closeDb`, `configureWsHost`,
  `defaultWsHost`, `cancelActiveTurn`, `isTurnActive`, the `brainClient`
  namespace and the `getBackends`/`getBackendsInfo` module functions — their
  replacements live on the app handle.
