---
"@schlessera/brain-module-images": minor
---

`brain image` now defaults to `gpt-image-2.6-sunburst`, and `gpt-image-2.6-flare` can be picked by name with `--model` or `preferredModels` (#3782). Both 2.5 models stay supported by name and are no longer chosen automatically while a 2.6 model is available.

Without `--quality`, every OpenAI request is now sent `quality: "max"` instead of leaving the choice to the API (`auto`). Max is the highest and most expensive tier: at 1024x1024 its output tokens cost about $0.21, against about $0.006 at `low`. To keep the old behaviour, pass `--quality auto`, or pass a lower tier. A dry run with `--size` or `--aspect` now gives a price without `--quality`.

The new `--complexity low|medium|high` flag sets how much a GPT Image 2.6 model plans before it renders. It has no separate fee. Without the flag, the 2.6 models are sent `high`. The 2.5 models and Gemini do not take complexity. Naming it with one of them, or giving a value outside the three, is refused before any request.

The retired-model error now names `gpt-image-2.6-sunburst` and `gpt-image-2.6-flare` as the replacements.
