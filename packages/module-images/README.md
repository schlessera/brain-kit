# @schlessera/brain-module-images

Image generation and editing for brain-kit. Adds `brain image` and an
`image-gen` skill, and routes between OpenAI and Google image models **by
capability rather than preference**.

```sh
brain image "a cutaway diagram of a heat pump, labelled" --text-in-image
brain image models
```

Enable it in `brain.config.ts`:

```ts
modules: {
  "@schlessera/brain-module-images": { imagesDir: "assets/images" },
}
```

Set `OPENAI_API_KEY`, `GEMINI_API_KEY`, or both. Each unlocks its own models;
neither is bundled, and the command reports what is reachable rather than
failing at the call.

## Why routing, not a default model

The two families are not interchangeable. Some requests only one of them can
serve at all:

| Request | Routes to | Reason |
|---|---|---|
| Masked inpainting | OpenAI | Google's image API has no mask concept |
| Transparent background | OpenAI, on the selected model | Both GPT Image 2.5 models return real alpha on png or webp; Gemini documents none |
| PNG or WebP | OpenAI | Every Gemini image model serves JPEG only |
| Exact custom pixels | OpenAI | Gemini has fixed ratios; the 2.5 models take any size on a 16px grid up to 3840px, 3:1 and 8.3MP |
| Character consistency | Gemini | Narrows to models that claim it; no benchmark picks a winner |
| >6 reference images | Gemini | 10 (Flash) / 14 (Lite) vs OpenAI's practical 8 |
| Watermark-free | OpenAI | Gemini always applies SynthID |

The policy is two named cases — everything, transparency included, to
`gpt-image-2.5-sunburst`, and throwaway work to `gemini-3.1-flash-lite-image`
via `--draft` — and everything else as fallback. `gpt-image-2.5-flare` is
supported and chosen by name (`--model` or `preferredModels`); an explicit
Flare stays Flare, transparency included. The OpenAI default is a maintainer
decision, not a benchmark result: `src/evidence.ts` carries the Gemini fallback
ordering, its sources and date, and the claims that did not survive checking,
all measured on models this module no longer uses for OpenAI. Set
`preferredModels` in the module config to override it.

`--quality` takes `low | medium | high | xhigh | max | auto` and is sent as
given. A transparent JPEG, an unknown quality or format, a `--size` that is
not `WIDTHxHEIGHT`, and a custom size outside OpenAI's rules are refused before
any request.

### Retired models

`gpt-image-2` and `gpt-image-1.5` are no longer supported. Naming either in
`--model`, `preferredModels` or `disabledModels` fails with an error naming the
replacements, and nothing falls back to them. To migrate:

- `gpt-image-2` → `gpt-image-2.5-sunburst` (the new default), or
  `gpt-image-2.5-flare` for speed.
- `gpt-image-1.5` (kept only for transparency) → drop the pin. Transparent
  requests now stay on Sunburst, or on Flare if you pick it.
- A retired ID in `disabledModels` no longer hides anything. Replace it with
  the 2.5 model you mean to hide, or remove it.

Quality is the default bias. Cost is always reported; `--draft` opts into the
cheapest model that fits, and `--dry-run` prices a decision without spending.
The 2.5 models are billed per token and default to `auto` quality, which the
API resolves per image, so they have no per-image price in `brain image
models`. A dry run with a stated `--quality` and size (`--size`, or an
`--aspect` the command turns into pixels) is priced from the output-token
calculator in OpenAI's image generation guide, which covers both models.
Prompt and reference-image input tokens come on top. Without both, the
estimate reads `null` (unknown). After a call, the cost is computed from the
token usage the API reported, when it reports any.

## Shape

`--aspect` and `--resolution` work on every model. Gemini takes ten fixed
ratios and 512px/1K/2K/4K directly; OpenAI has no aspect parameter, so a ratio
is converted to exact pixels on its 16-pixel grid inside the 0.65-8.3MP band.
`--size WxH` is OpenAI-only and routes accordingly.

## Live tests

Unit tests stub `fetch`. The real APIs are exercised by an opt-in suite:

```sh
BRAIN_IMAGES_LIVE=1 bun test packages/module-images/tests/live.test.ts
```

It spends real money and must never run in CI. Every model is tested
separately because they do not share a schema — that suite is what established
that all three Gemini models reject `image/png`, and that their bytes arrive in
`steps[].content[]` rather than the documented `output_image`. Neither is in
the vendor documentation. For the 2.5 models it decodes a transparent PNG and
requires both fully transparent and visible pixels, not just an alpha channel.
It does not require fully opaque pixels, which antialiased renders may lack.

## Environment

Every variable this package reads, and what happens when it is unset. This
table is generated from the package's env chokepoint — the single file allowed
to touch `process.env`.

<!-- env:begin -->

| Variable | What it controls | Unset |
| --- | --- | --- |
| `GEMINI_API_KEY` | API key for Google's image models (the gemini provider's declared apiKeyEnv). Absent key hides that provider's models. | — |
| `GEMINI_BASE_URL` | Override for the Gemini Interactions API endpoint. | https://generativelanguage.googleapis.com/v1beta |
| `OPENAI_API_KEY` | API key for the OpenAI image models (the openai provider's declared apiKeyEnv). Absent key hides that provider's models. | — |
| `OPENAI_BASE_URL` | Override for the OpenAI REST endpoint. | https://api.openai.com/v1 |

Generated from `packages/module-images/src/config/env.ts` by `bun run env-docs`. Edit the descriptor, not this table.
<!-- env:end -->
