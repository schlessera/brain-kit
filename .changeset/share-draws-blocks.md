---
"@schlessera/brain-ui-kit": minor
"@schlessera/brain-ui-react": minor
---

A shared answer (PNG or PDF) now draws its answer blocks, in a new print theme, where before it contained only the message's markdown. `@schlessera/brain-ui-kit` adds `PRINT_TOKENS`, `printThemeCss()` and a `[data-theme="print"]` block in its stylesheet: a white ground, no washes, and borders that carry the structure. `@schlessera/brain-ui-react` renders each `show_block` block and each classified block to static HTML in the print theme, in the order the answer shows them. A message with no block shares exactly as before.
