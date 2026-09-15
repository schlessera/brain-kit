---
"@schlessera/brain-ui-kit": minor
---

New package: `@schlessera/brain-ui-kit`, the presentational design kit.

The design tokens and a Storybook (10.6, Vite builder, CSF Next, interaction
tests in real Chromium). The component port follows in its own waves.

The kit is 100% prop-driven by construction: no stores, no `fetch`, no ambient
configuration, no browser globals. `bun run lint` grows a sixth gate,
`scripts/check-kit-purity.ts`, that enforces it rather than leaving it to review.
