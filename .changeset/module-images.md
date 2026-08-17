---
"@schlessera/brain-module-images": minor
---

New module: image generation and editing, routed by capability

Adds `brain image` and an `image-gen` skill. Two providers over plain `fetch`
— no vendor SDKs, because the deployment container has bun and nothing else.

Routing is capability-driven rather than a configured default. A mask, a
transparent background, PNG output or an exact pixel size can only be served by
OpenAI; in-image text, character consistency and large reference sets are
documented Gemini strengths. Where nothing in the request settles it, the
command stops and asks instead of guessing — no vendor benchmark decides
general image quality, and guessing spends real money. Quality is the default
bias; cost is always reported, `--draft` opts into the cheapest fit, and
`--dry-run` prices a decision without spending.

`--aspect` and `--resolution` work on every model: Gemini takes its ten fixed
ratios and resolution buckets directly, while OpenAI, which has no aspect
parameter, gets the ratio converted to exact pixels on its 16-pixel grid.

Three things in the capability table came from calling the APIs rather than
reading their docs, via the opt-in live suite
(`BRAIN_IMAGES_LIVE=1`, ~$0.35, never in CI):

- every Gemini image model rejects `image/png` and serves JPEG only
- Gemini returns image bytes inside `steps[].content[]`, not the `output_image`
  field the Interactions API reference documents
- `gpt-image-1.5` rejects the custom sizes `gpt-image-2` accepts, taking only
  1024x1024, 1536x1024 and 1024x1536
