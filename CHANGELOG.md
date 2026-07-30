# Changelog

All notable changes to `@endoxa/*` packages. Format:
[keep a changelog](https://keepachangelog.com/en/1.1.0/); versions are
lockstep across all packages.

## [Unreleased]

### Added

- `@endoxa/ui-sdk`, `@endoxa/ui-backend-claude`, `@endoxa/ui-backend-pi`:
  the chat-UI contract layer and its two agent backends (wire protocol, runtime
  schemas, `AgentBackend`/`SpeechProvider` seams, cross-backend contract suite).
- `@endoxa/ui-render-puppeteer`: optional HTML→PNG/PDF renderer for
  caller-supplied content. The page gets no network and no JavaScript, Chrome's
  sandbox stays on by default, and render time, concurrency, and output geometry
  are bounded.
- Protocol rev 2 (additive): `server_hello` handshake with `protocolRev`,
  `turnId` on session-scoped frames and interactive replies, `SessionRef`, and
  runtime zod schemas with `parseClientMessage` as the single inbound boundary.

### Changed

- **BREAKING** `defineModule` is two-phase: `{ name, configSchema?, setup(config) }`,
  where `setup` receives the validated config and returns the contribution. This
  lets a module's taxonomy dir follow its own config instead of a static literal.
  Contributions are schema-validated at load, and module commands now receive
  `{ root, json, config, taxonomy }` rather than re-reading `brain.config`.
- **BREAKING** `result.costUsd` is optional — absent means unknown, `0` means
  actually free. `result` carries an `outcome` (`success | error | cancelled`)
  and is the single terminal frame of every turn.
- `@google/genai` is an optional peer dependency of `@endoxa/core`, imported
  lazily by the built-in Gemini providers.

### Removed

- **BREAKING** `@endoxa/ui-backend-gemini`. It advertised `permissions: true`
  over a no-op gate, so mutations executed unapproved.

### Security

- Filesystem containment: config-supplied and caller-supplied paths are
  repo-relative and symlink-aware-resolved, so neither a symlinked directory nor
  a dangling symlink can redirect a write outside the brain root. Mutating
  commands refuse an uninitialized directory. `modules` keys are canonicalized
  before `import()`.
- Module cron fields are shape-constrained — container entrypoints materialize
  them into a root crontab.
- `@endoxa/ui-backend-claude` acquires its cross-session write lock in a
  `PreToolUse` hook. It previously lived in `canUseTool`, which the Agent SDK
  never invokes for tools in `allowedTools`, leaving the lock inert.

- Initial extraction of the endoxa core from the reference private
  implementation: config-driven taxonomy (`brain.config.ts` + zod schema),
  hybrid search (FTS5 + sqlite-vec), incremental indexer, CLI, MCP server,
  module system (jobs / speaking / finance), skills sync + emitters,
  onboarding primitives (`init` / `doctor` / `import` / `setup`), fixture
  corpus and contract tests.
