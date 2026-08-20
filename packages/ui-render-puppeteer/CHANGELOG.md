# @schlessera/brain-render-puppeteer

## 0.16.0

### Minor Changes

- f068ec2: Make browser crash recovery testable, and give the scraper the recovery it was
  missing.

  Both packages launch Chrome lazily and cache the handle. A few lines decide
  whether a crashed browser is replaced on the next call or leaves a dead handle
  cached until the process restarts — and with `puppeteer.launch` hardcoded, the
  only way to exercise them was to start real Chrome and kill it. Both now take a
  `launch` option, so a fake browser can be crashed on demand.

  **`brain-render-puppeteer`** gains the seam and tests for all four behaviours
  that were previously "verified by inspection": a crashed browser is replaced; a
  FAILED launch is not cached (a rejected promise left there is returned to every
  future caller, so one transient failure — Chrome mid-install, a momentary OOM —
  disables rendering for the life of the process); a late crash handler cannot
  discard the browser that already replaced it; and repeated failures keep
  retrying rather than latching. Four of the five tests fail against the code
  with the recovery removed.

  **`brain-scrape` had no recovery at all.** Its session was modelled on the
  renderer's lifecycle but shipped without the `disconnected` handling, so a
  Chrome crash mid-scrape left the dead handle cached and every subsequent page
  load failed against it. Fixed, with the same identity guards and the same
  seam. This is a bug fix, not a testing improvement.

  A caller overriding `launch` owns the isolation arguments too — the renderer's
  defaults are its security posture, not a convenience.

## 0.15.0

## 0.14.0

### Minor Changes

- 59de559: - Added: every package reads the environment in one chokepoint that declares
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

## 0.13.1

## 0.13.0

## 0.12.1

## 0.12.0

## 0.11.0

## 0.10.0

## 0.9.0

## 0.8.0

## 0.7.2

## 0.7.1

## 0.7.0

## 0.6.3

## 0.6.2

## 0.6.1

## 0.6.0

## 0.5.1

## 0.5.0

## 0.4.0

## 0.3.0

## 0.2.1

### Patch Changes

- Republish with correct internal dependency pins. The 0.2.0 manifests pinned
  cross-dependencies to 0.1.0, a version that was never published, making five
  of the eight packages uninstallable.

## 0.2.0

### Minor Changes

- rename brainform to brain-kit
