---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": patch
---

BREAKING: Live-conversation host work now uses the same ordinary backend,
session and principal policy as typed work, including session worker preference,
permitted writes and on-screen permission cards. It no longer implicitly selects
the narrower voice posture or declares no grant surface. Hosts relying on those
implicit restrictions must express them in their ordinary policy. Explicit
restricted backend requests remain enforced; speech still cannot grant permission.
Automatic conversational task admission and Gemini capture continuity remain
separate work.
