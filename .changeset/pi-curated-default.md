---
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

Pi runs on the host's curated tools by default. Managed input-safety collection refuses every loaded Pi extension, so an installed extension used to fail the first Pi turn and latch the safety recorder. Installed extensions now stay installed and inactive, and startup names them. The new `BRAIN_UI_PI_EXTENSIONS` setting (`curated`, the default, or `discover`) selects discovery for hosted servers. Hosted Pi now inspects its extension configuration as data, without importing or installing anything, before every roster read and turn. When that configuration would fail every managed turn (with `discover`, any extension; otherwise, a configured package that is not installed), Pi lists its profiles as unavailable with the new `unsupported-configuration` reason. It then refuses the turn before a worker starts, and Claude keeps running.

Breaking before 1.0: `createPiBackend`'s `loadExtensions` now defaults to `false` (was `true`). Pass `loadExtensions: true`, or set `BRAIN_UI_PI_EXTENSIONS=discover`, to keep discovery. With discovery on, managed turns still refuse loaded extensions. The maintainer ruling is recorded on #3658.
