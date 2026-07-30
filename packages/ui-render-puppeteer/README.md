# @endoxa/ui-render-puppeteer

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
import { createRenderer } from "@endoxa/ui-render-puppeteer";

const renderer = createRenderer();
const png = await renderer.renderPng({ html, width: 800 });
const pdf = await renderer.renderPdf({ html });
await renderer.shutdown();
```

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
