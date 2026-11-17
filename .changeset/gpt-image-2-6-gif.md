---
"@schlessera/brain-module-images": minor
---

`brain image --format gif` makes animated GIFs with the GPT Image 2.6 models, for new images and for edits with `--ref`. `--frames` (2-16) and `--frame-duration` (20-2000 ms) set the loop; without them OpenAI applies its defaults of 9 frames at 200 ms. GIF with `--mask` or `--transparent`, GIF on a 2.5 or Gemini model, and frame flags without `--format gif` are refused before any request. OpenAI serves GIF only to organizations with GIF preview access, and a refusal for missing access says so. A dry run reports a GIF's cost as unknown.
