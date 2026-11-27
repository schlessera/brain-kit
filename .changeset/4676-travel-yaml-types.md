---
"@schlessera/brain-module-travel": patch
---

Development dependencies only (#4676): `@types/js-yaml` now describes the `js-yaml` 3 line the module runs on (`^3.12.10` instead of `^4.0.9`), so a call that exists only in version 4 no longer type-checks, and the duplicate `typescript` entry in `devDependencies` is removed (it stays a runtime dependency). Nothing a consumer installs or runs changes.
