# Changelog

All notable changes to `@brainform/*` packages. Format:
[keep a changelog](https://keepachangelog.com/en/1.1.0/); versions are
lockstep across all packages.

## [Unreleased]

### Added

- Initial extraction of the brainform core from the reference private
  implementation: config-driven taxonomy (`brain.config.ts` + zod schema),
  hybrid search (FTS5 + sqlite-vec), incremental indexer, CLI, MCP server,
  module system (jobs / speaking / finance), skills sync + emitters,
  onboarding primitives (`init` / `doctor` / `import` / `setup`), fixture
  corpus and contract tests.
