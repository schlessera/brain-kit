---
name: image-gen
description: Use when an image needs making or changing — an illustration or asset for a document, a diagram or poster where the text must be legible, a mockup, a logo, a shareable graphic, or an edit to an image that already exists (replace part of it, restyle it, compose several references into one).
compatibility: Requires an API key for at least one image provider — OPENAI_API_KEY or GEMINI_API_KEY. Neither is bundled; each unlocks its own models.
---

# Image generation

**This skill orchestrates; `brain image` does the work.** It picks the model,
calls the API, prices the call and writes the file. Do not hand-roll HTTP
requests to an image API, and do not reach for a Python or Node image library —
a deployment may have neither.

```sh
brain image "a cutaway diagram of a heat pump, labelled" --text-in-image
brain image models        # what is available here, and what each is for
```

## The one thing to get right

**Routing is by capability, not by preference.** Some requests only one family
can serve, and the command enforces that. Where nothing in the request settles
it, `brain image` stops and asks rather than guessing — that is deliberate, not
a bug. Answer it by passing `--model` or `--provider`, after asking the user
which they want if you do not already know.

| The request involves | Goes to | Because |
|---|---|---|
| A mask — change *this* region | OpenAI | Google's image API has no mask concept at all |
| A transparent background | `gpt-image-1.5` | `gpt-image-2` rejects it outright |
| An exact odd pixel size | OpenAI | Gemini offers fixed ratios and 1K/2K/4K only |
| Legible text inside the image | `gpt-image-2` | Leads arena.ai's text-rendering board by ~130 Elo — its widest margin |
| Recurring characters staying consistent | Gemini | Only models that document it — but no benchmark picks a winner, so the default decides |
| More than 6 reference images | Gemini | Up to 10 (Flash) or 14 (Lite); OpenAI's practical ceiling is 8 |
| Output that must carry no watermark | OpenAI | Every Gemini image carries SynthID, with no documented opt-out |
| PNG or WebP output | OpenAI | Every Gemini image model serves JPEG only — verified against the live API, the docs do not say so |

### The three cases worth knowing

| Want | Gets | |
|---|---|---|
| Precision and quality | `gpt-image-2` | the default whenever nothing else applies |
| A transparent background | `gpt-image-1.5` | the only model that can |
| A quick throwaway illustration | `gemini-3.1-flash-lite-image` | pass `--draft`; about $0.03 |

Everything else is fallback — reached when one of those cannot serve the
request, never chosen ahead of them.

Pass the intent flags when the user's words imply them — `--text-in-image`,
`--characters`, `--no-watermark`, `--draft` — because they are what turns a
coin flip into a decision. **`--draft` is the one to reach for often**: a
sketch to think with, a placeholder, an illustration nobody will keep. Paying
seven times more for those is waste, and asking first is friction.

When nothing in the request decides, the command no longer asks: it takes the
highest-ranked available model in the public preference arenas, and says so.
That default is a reading of leaderboards on a date, not a law — if the user
prefers something else, set `preferredModels` in the module config and it wins.

## Shape

`--aspect` and `--resolution` work on every model, so ask for the shape you
want and let routing sort out how to express it:

```sh
brain image "a wide banner" --aspect 16:9 --resolution 2K
```

Gemini takes ten fixed ratios (1:1 2:3 3:2 3:4 4:3 4:5 5:4 9:16 16:9 21:9) and
the four buckets directly. OpenAI has no aspect parameter at all — the module
converts the ratio into exact pixels on OpenAI's 16-pixel grid, inside its
0.65-8.3MP band. Asking for a ratio outside Gemini's ten therefore routes to
OpenAI on its own.

`--size WxH` is the escape hatch for an exact pixel count, and is OpenAI-only.
Note that Gemini's buckets are pixel budgets rather than dimensions: `1K` with
no aspect came back 1408x768, not square.

## Cost

Quality is the default; cost is reported, never quietly optimised. Note that
price does not track quality here: `gemini-3-pro-image` costs twice
`gemini-3.1-flash-image` and scores below it on both public arenas. Rough per
image at ~1K:

| | |
|---|---|
| `gemini-3.1-flash-lite-image` | ~$0.034 |
| `gemini-3.1-flash-image` | ~$0.067 |
| `gemini-3-pro-image` | ~$0.134 |
| `gpt-image-2` (high) | ~$0.211 |

`--draft` takes the cheapest model that fits. `--dry-run` prints the decision
and the price without spending anything — use it when the user is likely to
want a different model, and when a request is large or repeated.

## Writing the file

Output lands under the configured images directory (`assets/images` by
default) unless `--out` says otherwise, and must stay inside the brain repo —
an image written elsewhere is invisible to anyone reading the brain, and to
the file viewer. A draft that should not become part of the brain goes to the
scratch area with `--scratch` (`.brain/scratch/`): the reader can open it, it
is never committed, and it is pruned after 7 days. Its name is unique to that
draft, so link to the path the command prints. Move it out to keep it.

Name it for what it is, not for the prompt: `heat-pump-cutaway.png` beats
`a-cutaway-diagram-of-a-heat.png`. Pass `--out` rather than renaming afterwards.

## Editing

```sh
brain image "replace the sky with heavy storm clouds" \
  --ref photos/house.png --mask photos/house-mask.png --out photos/house-storm.png
```

- `--ref` is repeatable; the first reference is the one a mask applies to.
- A mask is a PNG the same size as the image whose **fully transparent pixels
  mark what may change**. Masking is guidance, not a stencil — the model may
  soften the boundary.
- No mask? Describe the change instead. That is the only option on Gemini, and
  it is often the better one for restyling a whole image.

## When it fails

The command explains failures rather than dumping a status code, and says
whether a retry is worth it. Two that look like bugs but are not:

- **A refusal is not an error code.** Both APIs can return success with no
  image when a prompt trips moderation. The command surfaces the reason; relay
  it plainly and offer a rephrasing rather than retrying the same prompt.
- **GPT-image models need API Organization Verification.** Without it the
  OpenAI models fail no matter how valid the request is. That is an account
  setting, not something a different prompt fixes.
