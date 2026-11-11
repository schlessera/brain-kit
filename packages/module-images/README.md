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
| Transparent background | OpenAI, on the selected model | Every GPT Image 2.6 and 2.5 model returns real alpha on png or webp; Gemini documents none |
| PNG or WebP | OpenAI | Every Gemini image model serves JPEG only |
| Exact custom pixels | OpenAI | Gemini has fixed ratios; the 2.6 and 2.5 models take any size on a 16px grid up to 3840px, 3:1 and 8.3MP |
| `--complexity` | OpenAI GPT Image 2.6 | Only the 2.6 models take it; it is refused anywhere else |
| Animated GIF (`--format gif`) | OpenAI GPT Image 2.6 | Only the 2.6 models return GIF; it is refused anywhere else |
| Static SVG (`--format svg`) | OpenAI GPT Image 2.6 | Only the 2.6 models author SVG, on new images only |
| Character consistency | Gemini | Narrows to models that claim it; no benchmark picks a winner |
| >6 reference images | Gemini | 10 (Flash) / 14 (Lite) vs OpenAI's practical 8 |
| Watermark-free | OpenAI | Gemini always applies SynthID |

The policy is two named cases — everything, transparency included, to
`gpt-image-2.6-sunburst`, and throwaway work to `gemini-3.1-flash-lite-image`
via `--draft` — and everything else as fallback. `gpt-image-2.6-flare`,
`gpt-image-2.5-sunburst` and `gpt-image-2.5-flare` are supported and chosen by
name (`--model` or `preferredModels`); an explicit choice stays put,
transparency included. The OpenAI default is a maintainer
decision, not a benchmark result: `src/evidence.ts` carries the Gemini fallback
ordering, its sources and date, and the claims that did not survive checking,
all measured on models this module no longer uses for OpenAI. Set
`preferredModels` in the module config to override it.

`--quality` takes `low | medium | high | xhigh | max | auto` and is sent as
given. Without it, every OpenAI request sends `max`, the highest and most
expensive tier. `--complexity low | medium | high` sets how much a GPT Image
2.6 model plans before it renders. It has no separate fee, and without it the
2.6 models are sent `high`. The 2.5 models and Gemini do not take it, so naming
it with them is refused. A transparent JPEG, an unknown quality, complexity or
format, a `--size` that is not `WIDTHxHEIGHT`, and a custom size outside
OpenAI's rules are refused before any request.

`--format gif` asks a GPT Image 2.6 model for an animated GIF, for a new image
or an edit with `--ref`. `--frames` (2-16) and `--frame-duration` (20-2000 ms)
set its frame count and timing; without them the API uses its own defaults of 9
frames at 200 ms. The frame flags need `--format gif`. A GIF takes no `--mask`
and no `--transparent`, and the 2.5 models and Gemini cannot return one; each of
these is refused before any request. OpenAI serves GIF only to organizations
with GIF preview access, and the refusal says so. A dry run reports a GIF's cost
as unknown, because OpenAI publishes no per-frame token count.

`--format svg` asks a GPT Image 2.6 model to author a static SVG, written as
UTF-8 XML to a `.svg` file. It works on new images only: `--ref`, `--mask`,
`--transparent`, the 2.5 models and Gemini are refused before any request.
OpenAI says the output is static, but the module checks rather than trusts it.
An SVG that is not UTF-8 or not an SVG document, or that contains a DOCTYPE,
`<script>`, `<foreignObject>`, an embedding element, an event-handler attribute,
an `@import`, or any `href`, `src` or `url()` that is not a `#fragment`, is
refused and nothing is written. The call has still been paid for. SVG authoring
tokens are billed at a rate this module does not know, so the cost is reported
as unknown, before and after the call. The `svg` authoring-model option is
never sent.

### Retired models

`gpt-image-2` and `gpt-image-1.5` are no longer supported. Naming either in
`--model`, `preferredModels` or `disabledModels` fails with an error naming the
replacements, and nothing falls back to them. To migrate:

- `gpt-image-2` → `gpt-image-2.6-sunburst` (the default), or
  `gpt-image-2.6-flare` for speed.
- `gpt-image-1.5` (kept only for transparency) → drop the pin. Transparent
  requests now stay on Sunburst, or on Flare if you pick it.
- A retired ID in `disabledModels` no longer hides anything. Replace it with
  the model you mean to hide, or remove it.

Quality is the default bias. Cost is always reported; `--draft` opts into the
cheapest model that fits, and `--dry-run` prices a decision without spending.
The 2.6 and 2.5 models are billed per token, so they have no per-image price in
`brain image models`. A dry run with a size (`--size`, or an `--aspect` the
command turns into pixels) is priced at the request's quality, `max` unless
stated, from the output-token calculator in OpenAI's image generation guide,
which covers all four models. Prompt and reference-image input tokens come on
top. Without a size, or with `--quality auto`, the estimate reads `null`
(unknown). After a call, the cost is computed from the
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
the vendor documentation. For the 2.6 and 2.5 models it decodes a transparent PNG and
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
