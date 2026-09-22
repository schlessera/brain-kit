---
"@schlessera/brain-module-jobs": patch
---

Manifest only: `happy-dom` joins this package's devDependencies, so the three
browser boards' page extractors can be run against their committed fixtures in
a test without launching Chrome. Nothing a consumer installs or calls changes —
`dependencies`, `peerDependencies`, `exports` and `engines` are untouched — but
the manifest ships, so this is recorded rather than waved through.
