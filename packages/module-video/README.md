# Video module

An opt-in Gemini engine for `brain video watch`. It watches picture and audio
without downloading a YouTube video or requiring ffmpeg/yt-dlp.

```bash
bun add @schlessera/brain-module-video "@google/genai@^2.24.0"
```

Enable it in `brain.config.ts`:

```ts
modules: {
  "@schlessera/brain-module-video": {
    engine: "gemini",
    timeoutMs: 300000,
  },
}
```

The model defaults to core's `GEMINI_FLASH_MODEL`. Set `model` to override it.
Only `engine: "gemini"` is supported. The command respects core's configured
completion provider: Anthropic and providers without `capabilities.video: true`
are refused. An existing custom Gemini provider is used as configured, with its
own model; the module model override applies to the built-in Gemini provider.
Video calls never silently fall back to another provider.

Set **GEMINI_API_KEY** in the calling environment (or the variable named by
`completions.apiKeyEnv`). The command does not prompt for or print a key. See
[core environment configuration](../../docs/configuration.md).

```bash
brain video watch "https://www.youtube.com/watch?v=Odysseus001" --question "What is demonstrated at the start?" --start 0:00 --end 2:00 --json
brain video watch "assets/odysseus-demo.mp4" --question "Which preparations are visible?" --json
```

The URL above is illustrative, not a real video. Only HTTPS public YouTube
watch, shorts, embed and youtu.be URLs identifying a single video are supported.
Private/unlisted/authenticated videos are unsupported. File paths are explicit
user inputs; relative paths resolve from the brain root. Supported extensions:
mp4, mpeg, mpg, mov, avi, flv, webm, wmv, 3gp. No video is stored or indexed.
Times are seconds, mm:ss or hh:mm:ss; clip end must be greater than start.

Google receives the video or URL and your question. Free-tier data may be used
for training depending on your region and account terms. The command discloses
this on stderr before calling; `/watch` requires agreement first. Read Google's
[current terms](https://ai.google.dev/gemini-api/terms) before sending sensitive
material. Model answers and video-derived instructions are untrusted evidence.

The Gemini SDK must be 2.24.0 or newer within major 2: the request-bound fetch
option used to cover upload cancellation is absent from the former 2.10.0
minimum.

Local files are uploaded to the Files API, polled until ACTIVE, used once, and
deleted even after generation, processing or deadline failure. Deletion has a
fresh 10-second deadline. If deletion fails, the command fails and names the
remote file to delete; it does not report success. Files normally expire after
48 hours. Caller-supplied Files API URIs at the core seam are never deleted.
If upload fails before returning a file name, cleanup cannot be confirmed; check
your Files API list. The configured timeout bounds video upload HTTP requests,
polling and generation; cleanup can extend the total by up to 10 seconds per file.

## JSON result

```json
{
  "source": { "kind": "youtube", "url": "https://www.youtube.com/watch?v=Odysseus001", "path": null, "title": null, "durationSeconds": null },
  "engine": "gemini",
  "model": "<configured model>",
  "clip": { "start": 0, "end": 120 },
  "answer": "00:10 The model observes preparations for the voyage.",
  "timestamps": ["00:10"],
  "warnings": ["Source title and duration are unavailable; they were not inferred from model observations."]
}
```

Local sources have `kind: "file"`, the supplied `path`, a filename `title`, and
`url: null`. Metadata unavailable without another service remains null.
`timestamps` contains distinct, syntactically valid original-video citations
inside the requested clip; citations outside it generate a warning and remain
visible in the unchanged `answer`. A missing citation also generates a warning.
A nonzero exit writes diagnostics to stderr and emits no success JSON.

Removing the module declaration removes its command, skill and generated context.
Dormancy (`enabled: false`) removes its skill/context and preserves core's
dormant namespace guard, which explains how to enable it rather than watching.
No MCP tool, local engine, speech fallback or asset sidecar is added here.

[Video request API](https://ai.google.dev/gemini-api/docs/generate-content/video-understanding)
· [Files API](https://ai.google.dev/api/files)
