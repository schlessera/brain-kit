# @schlessera/brain-render-puppeteer

Server-side PNG/PDF rendering for caller-supplied HTML, on headless Chrome
(`puppeteer-core` — bring your own Chrome). Built for one hostile fact: **the
content being rendered is untrusted**, and the renderer usually runs next to a
private knowledge repo. A page that can fetch — or open a WebSocket — is an
SSRF and exfiltration vector, so the page gets nothing:

- **No network.** The browser's DNS is blackholed at launch — the load-bearing
  layer, because request interception cannot see WebSocket handshakes,
  prerender, preconnect, iframes, or popups. Interception runs *as well*,
  belt-and-braces.
- **No JavaScript.** Scripting is disabled for rendered content.
- **Chrome's sandbox stays on** by default (opt out only where the process
  already runs as root, e.g. minimal containers).
- **Bounded everything**: per-render wall-clock budget (30 s, launch included),
  bounded concurrency (2) with a bounded queue, clamped output geometry, idle
  browser shutdown, crash recovery, terminal `shutdown()`.

Practical consequence: remote images and webfonts do not render. Inline assets
as `data:` URIs if they must appear.

```ts
import { createRenderer } from "@schlessera/brain-render-puppeteer";

const renderer = createRenderer();
const png = await renderer.renderPng({ html, width: 800 });
const pdf = await renderer.renderPdf({ html });
await renderer.shutdown();
```

PDFs honour the document's `@page` rule (`preferCSSPageSize`): its size, its
margins and any footer in its margin boxes. A document without one gets A4 and
16 mm margins. The shell from
[`@schlessera/brain-render-template`](../render-template) sets full-bleed A4
and draws its footer that way.

`chrome-headless-shell` renders the same pages in about half the time of full
Chrome (a median 143 ms against 296 ms from launch to close, Chrome 140, seven
cold runs). Point `PUPPETEER_EXECUTABLE_PATH` at it to use it. It is not
searched for: a broken binary found first would stop every render even with a
working Chrome installed.

## Options

| Option | Default | Notes |
|---|---|---|
| `executablePath` | `PUPPETEER_EXECUTABLE_PATH` / well-known paths | Chrome binary. |
| `renderTimeoutMs` | `30_000` | Per-render wall clock, browser launch included. |
| `maxConcurrent` | `2` | Renders in flight; more queue. |
| `maxQueue` | `16` | Waiting renders beyond the cap before "renderer busy". |
| `idleTimeoutMs` | 5 min | Close the browser after this long without a render. |
| `allowHosts` | `[]` | Explicit host allowlist excluded from **both** the DNS blackhole and interception. A predicate was rejected by design — it could only gate the interceptable channels. |

## Verification

The unit tests cover the predicates; the suite that matters launches **real
Chrome against a live listener** and proves the page cannot reach it over
fetch, WebSocket, prerender, preconnect, iframe, or popup
(`tests/runtime.test.ts`). Predicate-only tests hid exactly these holes once;
keep the runtime suite green.

## Environment

Every variable this package reads, and what happens when it is unset. This
table is generated from the package's env chokepoint — the single file allowed
to touch `process.env`.

<!-- env:begin -->

| Variable | What it controls | Unset |
| --- | --- | --- |
| `BRAIN_UI_CHROME_PATH` | Chrome/Chromium executable to launch (brain-ui's spelling; checked after PUPPETEER_EXECUTABLE_PATH). | well-known system install paths |
| `PUPPETEER_EXECUTABLE_PATH` | Chrome/Chromium executable to launch (checked first). Point it at chrome-headless-shell to render in about half the time of full Chrome. | well-known system install paths |

Generated from `packages/ui-render-puppeteer/src/config/env.ts` by `bun run env-docs`. Edit the descriptor, not this table.
<!-- env:end -->
