---
"@schlessera/brain-ui-server": minor
---

A strict, voice or autonomous turn that applies an image mask now reads the new PNG in its own data tree before its next read, and the scratch files the mask's prune removed are gone from it; a Claude `Read` of the mask at the brain path is refused like any other path the turn applied. In a provider-masked turn the PNG enters the tree only under the provenance rule, compared byte for byte. `AppliedEffect` accepts `Uint8Array` content and base (additive).
