---
type: note
title: Hello, brain
created: 2026-01-01
updated: 2026-01-01
status: active
relevance: primary
tags: [getting-started, example]
---

# Hello, brain

This is the one note your brain ships with. It exists so there is something to
find before you have written anything of your own — a pre-init smoke test.

Try it now, no API key required:

```sh
brain search hello
```

You should see this file come back. That confirms indexing and full-text search
work end to end. Search by meaning (semantic search) needs a `GEMINI_API_KEY` —
see `.env.example` — but plain text search works out of the box.

When you are ready to make the brain yours, run `/brain-init` in your coding
agent. It will interview you, build a directory taxonomy that fits your life,
and seed `me/identity.md`. You can safely delete this note afterward.
