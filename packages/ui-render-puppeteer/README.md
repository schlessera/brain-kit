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
- **Bounded everything**: separate queue (30 s), browser acquisition (60 s), and
  page creation/rendering (30 s) budgets, bounded concurrency (2) with a bounded queue, clamped output geometry, idle
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
| `queueTimeoutMs` | `30_000` | Waiting for a concurrency slot; expiry rejects immediately and removes the waiter. |
| `browserTimeoutMs` | `60_000` | Acquiring the shared browser, including a cold launch. |
| `renderTimeoutMs` | `30_000` | Page creation, setup, and PNG/PDF production; excludes queue waiting and browser acquisition. |
| `maxConcurrent` | `2` | Renders in flight; more queue. |
| `maxQueue` | `16` | Waiting renders beyond the cap before "renderer busy". |
| `idleTimeoutMs` | 5 min | Close the browser after this long without a render. |
| `allowHosts` | `[]` | Explicit host allowlist excluded from **both** the DNS blackhole and interception. A predicate was rejected by design — it could only gate the interceptable channels. |

The phases are sequential. A render rejects or returns within
`queueTimeoutMs + browserTimeoutMs + renderTimeoutMs` (120 s by default),
subject to event-loop scheduling. Timeouts identify the phase: `Render queue
exceeded …ms budget`, `Browser acquisition exceeded …ms budget`, or `Render
exceeded …ms budget`. A full queue still rejects immediately as renderer busy.
All three budgets must be positive integers within JavaScript's timer range.

**Pre-1.0 behavior change (#72):** `renderTimeoutMs` previously covered the
queue and browser launch too. Set the three phase allowances explicitly if you
need a particular total duration; setting only `renderTimeoutMs` now limits
page creation/rendering. The 60 s acquisition allowance accommodates the
measured CI startup tail, while rendering retains its 30 s allowance. See
[the measurements and ruling](../../docs/decisions/renderer-budgets.md).

Timed-out calls release capacity. An abandoned launch is detached and any
browser it returns later is closed, so the next call can relaunch. A shared
launch survives while another caller needs it; a render timeout closes only
that call's page. Late pages are closed without use. `shutdown()` is terminal:
it rejects queued calls immediately, drains active phases, and gives browser
closure at most another 2 s. Its maximum wait is therefore
`browserTimeoutMs + renderTimeoutMs + 2_000` (92 s by default). Shutdown calls
share one drain/close operation. Page cleanup never holds a concurrency slot.

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

## Visible destinations in app exports

The optional per-render `linkPolicy: "visible-destinations"` is shared with
`buildHtmlDocument`. `POST /api/render` always supplies it for PNG and PDF;
request fields and bare/full HTML cannot disable it. Omission preserves the
renderer/CLI defaults. The option adds canonical ASCII hosts or validated mail
addresses, makes refused/unavailable targets inert, removes content bases and
nested-document navigation, and does not fetch links.

This policy forces document JavaScript off, freezes motion and protects real
destination text after loading in the final screen/print mode. Hidden/clipping
styles are repaired without replacing normal block layouts. If every glyph
cannot be drawn and hit-tested, an overlay obscures it, or PNG would crop it at
the existing capture limit, rendering rejects. The existing render deadline
bounds these checks. For PDF the renderer also checks the finished bytes with
its lazily loaded PDF.js dependency: every external annotation must belong to
a tagged link with its own complete disclosure on that physical page, at least
9 PDF points (12 CSS pixels). Custom page sizes or print scaling that crop or
shrink that disclosure reject. Unrelated body text cannot satisfy this check.
Network denial, sandboxing and concurrency/budget defaults
stay unchanged. Custom implementations injected into the app's rendering seam
must honor both structural classification and final visible disclosure.
