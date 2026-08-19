---
"@schlessera/brain-ui-server": minor
"@schlessera/brain": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-render-puppeteer": minor
"@schlessera/brain-module-images": minor
"@schlessera/brain-module-jobs": minor
"@schlessera/brain-module-finance": minor
---

- Added: every package reads the environment in one chokepoint that declares
  each variable, exports the contract (`ENV_VARS`, `resolveEnv`, `readEnvVar`)
  from the package entry, and generates its README env table from it.
- Added: `ui-server` exports a resolved `ServerConfig` and returns an app handle
  (`config`, `db`, `wsHost`, `isTurnActive`, `cancelActiveTurns`, `close`), so
  two differently-configured apps coexist in one process.
- Added: `openBrainDb`/`withBrainDb` gate every `brain.db` read on
  `schema_version`; `assertBackendResolvable` refuses to boot when the selected
  agent backend is not installed.
- Changed: `@schlessera/brain-backend-claude` is an optional peer of
  `ui-server`, not a dependency — a deployment declares the backend it uses.
- Changed: the module contract carries the config generic through
  `CommandContext`, `HygieneContext` and `CommandModule`, so a module author no
  longer casts a value the loader already validated.
- Changed: the Gemini providers no longer delete and restore `GOOGLE_API_KEY`
  around client construction.
- Removed: `configureDb`, `getDb`, `closeDb`, `configureWsHost`,
  `defaultWsHost`, `cancelActiveTurn`, `isTurnActive`, the `brainClient`
  namespace and the `getBackends`/`getBackendsInfo` module functions — their
  replacements live on the app handle.
