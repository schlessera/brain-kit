---
"@schlessera/brain-module-images": minor
---

`brain image --dry-run` now prices a GPT Image 2.5 request when you give a quality and a size. The size can come from `--size`, or from an `--aspect` the command turns into pixels. The estimate comes from the output-token calculator in OpenAI's image generation guide, which covers both Sunburst and Flare, and does not include input tokens. With `auto` quality or no size, `estimatedCostUsd` stays `null`.

A `--size` that is not `WIDTHxHEIGHT` or `auto`, such as `big` or `1024x`, is now refused before the provider is called. Previously it went to the API unchecked.
