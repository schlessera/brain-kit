---
"@schlessera/brain-module-images": patch
---

Correct the image-model capability strings so they say what the evidence says.

`evidence.ts` retracted two vendor-sourced claims and fixed routing accordingly,
but the user-facing half was left behind: `brain image models` still printed
"Nano Banana Pro — strongest text rendering, 5-character consistency", and the
`strongTextRendering` flag still marked every Gemini model true and both OpenAI
models false. Anyone reading the command output got the retracted version.

- The `strongTextRendering` flag now carries the measured direction —
  `gpt-image-2` true, every Gemini model false. It fed only `strongestFirst()`,
  which already reached the same order by price within a provider, so no routing
  decision changes.
- Model summaries state each model's actual role: `gpt-image-2` the default that
  leads the arenas, `gpt-image-1.5` the transparency-only fallback,
  `gemini-3-pro-image` a fallback that scores below Flash at twice the price,
  `gemini-3.1-flash-lite-image` the `--draft` tier.
- `tests/providers.test.ts` guards both, so a retracted claim cannot re-enter the
  copy while routing stays correct.
