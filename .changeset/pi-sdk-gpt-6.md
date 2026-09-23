---
"@schlessera/brain-backend-pi": minor
---

The pi SDK (`@earendil-works/pi-coding-agent`, `pi-agent-core`, `pi-ai`) moves
from 0.84.4 to 0.87.1, so `openai-codex` profiles for `gpt-6-sol` and
`gpt-6-luna` (and `gpt-6-astra`) now resolve instead of failing with
`Unknown model`. `gpt-5.6-sol`, `gpt-5.6-luna` and `gpt-5.6-terra` still
resolve. pi 0.86.0 dropped `gpt-5.4` and `gpt-5.4-mini` from its OpenAI Codex
catalog, so a profile still naming either now fails with `Unknown model`.
