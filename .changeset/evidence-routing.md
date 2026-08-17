---
"@schlessera/brain-module-images": minor
---

Route on measured evidence instead of vendor documentation, and stop asking

The router's tie-break was "no vendor publishes a head-to-head, so ask the
user". That is true of vendors and false of the field: public preference arenas
carry millions of votes, and checking them overturned two rules this module
shipped with.

- **In-image text routed to Gemini. That was backwards.** The rule reasoned
  from documentation — Google documents text rendering as a strength, OpenAI
  documents nothing — but vendor silence is not weakness. arena.ai has a
  dedicated text-rendering board and `gpt-image-2` leads it by ~130 Elo, its
  widest category margin.
- **Character consistency claimed a Gemini win it cannot support.** No
  independent benchmark for identity preservation exists, and Google's own
  model card scores character editing as a tie inside the error bars. The rule
  now narrows to models that document the capability and lets the default
  decide, rather than asserting a winner.
- **Ambiguity now resolves.** A request with no capability signal takes the
  highest-ranked available model and says so, instead of stopping to ask.
  `preferredModels` in the module config overrides it.
- **The Gemini default is Flash, not Pro.** Pro costs twice as much and scores
  below Flash on both arenas. Price was being used as a proxy for quality; it
  is not one.
- **`--draft` now names its model** rather than searching for the cheapest
  survivor: a quick throwaway illustration is `gemini-3.1-flash-lite-image` at
  about $0.03, because "cheapest thing that happens to fit" and "good quick
  sketch" are not the same question.

The shipped policy is three named cases — quality to `gpt-image-2`,
transparency to `gpt-image-1.5`, throwaway work to
`gemini-3.1-flash-lite-image` — with everything else as fallback only.

The ordering, its sources, its as-of date, and the claims that did NOT survive
checking all live in `src/evidence.ts` — including the widely-repeated "Nano
Banana Pro beats GPT-Image on text rendering", which is Google's own eval
against GPT-Image **1**, five months before gpt-image-2 existed.
