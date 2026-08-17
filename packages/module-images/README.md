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
| Transparent background | `gpt-image-1.5` | `gpt-image-2` rejects `background: transparent` |
| PNG or WebP | OpenAI | Every Gemini image model serves JPEG only |
| Exact custom pixels | `gpt-image-2` | Gemini has fixed ratios; `gpt-image-1.5` takes three presets |
| Legible in-image text | `gpt-image-2` | Leads arena.ai's text-rendering board by ~130 Elo |
| Restyling | `gemini-3-pro-image` | The one row Google's own card puts ahead of gpt-image-2 |
| Character consistency | Gemini | Narrows to models that claim it; no benchmark picks a winner |
| >6 reference images | Gemini | 10 (Flash) / 14 (Lite) vs OpenAI's practical 8 |
| Watermark-free | OpenAI | Gemini always applies SynthID |

When nothing in the request settles it, the command takes the highest-ranked
available model in the public preference arenas and says that is what it did.
`src/evidence.ts` carries the ordering, the sources, the date, and — as
importantly — the claims that did not survive checking. Set `preferredModels`
in the module config to override it.

Quality is the default bias. Cost is always reported; `--draft` opts into the
cheapest model that fits, and `--dry-run` prices a decision without spending.

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

It costs roughly $0.35 and must never run in CI. Every model is tested
separately because they do not share a schema — that suite is what established
that all three Gemini models reject `image/png`, that their bytes arrive in
`steps[].content[]` rather than the documented `output_image`, and that
`gpt-image-1.5` rejects custom sizes that `gpt-image-2` accepts. None of those
three are in the vendor documentation.
