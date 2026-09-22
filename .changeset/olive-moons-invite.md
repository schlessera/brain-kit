---
"@schlessera/brain": minor
---

`brain init --check` now reports `config.initialized` alongside `config.exists`.
The template ships a `brain.config.ts` with every field commented out, so
`exists` was true on a brain that had never been set up, and `/brain-init`
took its amend-mode branch for every new user instead of running the interview.
`initialized` is true only once the config declares something — a profile, a
taxonomy, a module, an embedding provider — and the brain-init skill branches on
it. Additive: the existing fields are unchanged.
