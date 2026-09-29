---
"@schlessera/brain-module-images": minor
---

`brain image` now defaults to `gpt-image-2.5-sunburst` and supports `gpt-image-2.5-flare` by name (`--model` or `preferredModels`). Both models take transparent backgrounds on png or webp, masks, custom sizes and the new `xhigh` and `max` quality tiers. A transparent request stays on the selected model, and an explicit Flare stays Flare. `--quality xhigh|max` is sent as given, never lowered to `high`.

**Retired models:** `gpt-image-2` and `gpt-image-1.5` are no longer supported, and nothing falls back to them. Naming either in `--model`, `preferredModels` or `disabledModels` fails before any request with an error that names both replacements. To migrate, replace `gpt-image-2` with `gpt-image-2.5-sunburst` (or `gpt-image-2.5-flare` for speed). Remove any `gpt-image-1.5` pin, because transparency no longer needs a separate model. A retired ID in `disabledModels` no longer hides anything, so replace it with the 2.5 model you mean to hide.

A transparent JPEG, an unknown `--quality` or `--format`, and a custom `--size` outside OpenAI's rules (16px grid, 3840px edge, 3:1 ratio, 0.65-8.3MP) are now refused before the provider is called.

Cost: OpenAI publishes no per-image price for the 2.5 models and bills them per token. Before a call, their cost is unknown: `approxCostUsd1K` in `brain image models --json` and `estimatedCostUsd` in a `--dry-run` are `null` for them. After a call, `costUsd` is computed from the token usage the API reported at the published rates, and is `null` when the reply carries no usage. The JSON envelopes keep their keys. `ModelCapabilities.approxCostUsd1K` is now `number | null`. The package export `estimateOpenAiCost` is replaced by `openAiCostFromUsage`. `brain image` output is not part of the integration contract.
