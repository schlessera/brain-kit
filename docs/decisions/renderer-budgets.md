# Renderer phase budgets

Decided by the maintainer on 2026-09-28 in
[#72](https://github.com/schlessera/brain-kit/issues/72#issuecomment-5870061520).
Measured and implemented 2026-09-30.

## Separate queue, acquisition and rendering

Queue waiting has its own deadline and removes an expired waiter immediately.
Browser acquisition includes the shared lazy launch. Only after it finishes
does the rendering allowance begin; page creation belongs in that allowance.
Each timeout names its phase. The defaults are 30 s queue, 60 s browser
acquisition and 30 s rendering, implying a maximum request duration of 120 s,
subject to event-loop scheduling. No independent overall-deadline option is
added.

Previously `renderTimeoutMs` covered queue waiting, launch and rendering,
although queue expiry was only checked after a slot became available. That
made cold startup subtract from the time available to render. This is a
published option behavior change, authorized before 1.0 and named in the
minor changeset. Consumers needing a total duration allocate it across the
three phases.

## Measurements behind the defaults

The original CI evidence is ten successive `ubuntu-latest` jobs, reported in
[#72's measurement comment](https://github.com/schlessera/brain-kit/issues/72#issuecomment-5769110927):
first Chrome launch plus trivial render cost 6687, 9449, 9909, 12045, 13608,
6311, 8295, 7884, 1517 and 1739 ms. Median 8090 ms; eight of ten exceeded 6 s.
Earlier runs included a first launch above 20 s, while later launches on the
same runner cost 0.4–2.3 s. The 60 s acquisition default allows headroom beyond
that observed tail without taking any of rendering's existing 30 s allowance.
An observed maximum is not a bound on another host. Slow hosts can override
acquisition explicitly; wedged startup still has a deadline.

Ten fresh containers on 2026-09-30 used the existing
`mcr.microsoft.com/playwright:v1.63.0-noble` image (Ubuntu 24.04.4, x86_64,
Chrome for Testing 153.0.8010.12, Bun 1.3.14). Docker Engine 29.7.2 used its
default 64 MiB shared-memory setting. Each container had networking disabled,
one new renderer, the standard hardened launch arguments and the explicit
`noSandbox` opt-in required for its root user. Each produced an actual PNG.
No deployment image or data was used.

| Phase | Samples (ms), in order | Median | Range |
| --- | --- | --- | --- |
| Browser launch | 208, 197, 189, 181, 180, 234, 189, 234, 180, 197 | 193 | 180–234 |
| First render after launch | 129, 158, 133, 115, 141, 143, 124, 103, 149, 134 | 133.5 | 103–158 |
| Total | 337, 355, 321, 296, 321, 377, 313, 337, 329, 331 | 330 | 296–377 |

These are the first browser launches in fresh containers, not cold disk-cache
measurements: containers share the host's page cache. An initial pilot before
these ten samples cost 488 ms launch and 141 ms render. The container results
do not negate the larger CI tail. Queue waiting keeps a 30 s allowance to
bound backpressure independently of startup; two concurrent renders and a
16-entry queue remain the defaults.

Reproduce with `packages/ui-render-puppeteer/tests/cold-start.ts`: pass the
Chrome executable as its first argument, and `--no-sandbox` only when required.
Run it once per fresh process/container. The CI test shards run this probe
before any test warms Chrome, printing launch, rendering and total times
separately. It asserts that real PNG bytes were produced; it has no performance
threshold and loads no remote content.

## Resource ownership and shutdown

Calls share a launch but each has its own acquisition deadline. A timed-out
waiter releases its slot; the launch remains owned while another waiter or
render needs it. When its last waiter leaves before launch resolves, retire
it, allow the next call to relaunch, and close a browser arriving late. Stale
disconnect/rejection handlers cannot evict a replacement. Timed-out page
creation closes its late page without configuring it, and late setup/content
continuations cannot start a capture.

Shutdown rejects queued calls, refuses new renders and drains active calls
within their remaining acquisition/rendering budgets. It never awaits an
abandoned launch. Browser closure has a separate fixed 2 s cleanup bound;
page closure is detached from capacity release. Repeated shutdown calls share
one operation. One waiter timing out cannot close another render's browser.

## Alternatives rejected

- One larger end-to-end budget still charges startup to rendering and leaves
  its allowance dependent on cold-host latency.
- An additional overall deadline duplicates the phase bounds and was excluded
  by the ruling; the sum makes the total duration explicit.
- Startup prewarming trades idle memory for latency and belongs to lifecycle
  policy, outside this budget change.
- A timeout race around uncancellable queue waiting returns an error but leaves
  a ghost waiter that can later consume capacity.
- Closing a shared browser whenever one caller expires invalidates handles
  another active call still needs. Browser ownership and page cancellation
  must be tracked separately.

Sandbox, DNS denial and request interception retain their existing policy.
