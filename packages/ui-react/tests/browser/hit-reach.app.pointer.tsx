/**
 * #3252, the app screens outside Settings: controls keep their kit paint and
 * reach 44px past it under a coarse pointer, instead of drawing a 44px box.
 *
 * Runs in the rail-fine, rail-coarse and rail-mixed projects, each a native
 * pointer premise with no matchMedia mock. Each scene is a migrated site from
 * voice, chat, graph, files, layout and report, drawn at 320px and 1280px, and
 * `reach` checks it: no kit Button inflates its box to 44px (the failing-first
 * assertion: on main each of these Buttons carried `minHeight: 44`), every
 * enabled Button under 44px reaches under a coarse pointer, and every enabled
 * control owns `elementFromPoint` 1px inside each edge of its target, so a
 * reach that steals is caught on the neighbour it steals from.
 */
import { expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import type { ReactNode } from "react";
import { WorkerHostNotice } from "../../src/components/chat/worker-host-notice.js";
import { NodeCard } from "../../src/components/graph/node-card.js";
import { ViewerFailure } from "../../src/components/files/file-viewer-frame.js";
import { FileViewerBinary } from "../../src/components/files/file-viewer-binary.js";
import { PageBoundary } from "../../src/components/layout/page-boundary.js";
import { DiagnosticReview } from "../../src/components/report/diagnostic-review.js";
import { coarsePointer, describeHit, edgeOwners, OWNED } from "./hit-reach.js";
import { mount, reach } from "./hit-reach-scene.js";

const noop = () => {};
const offline = async () => Response.json({});
const button = (name: string) => page.getByRole("button", { name, exact: true });

/** A raw control migrated to `.bk-hit` keeps its own paint under 44px. */
function rawReach(el: HTMLElement, label: string) {
  expect(el.classList.contains("bk-hit"), `${label}: carries the hit-area utility`).toBe(true);
  expect(el.getBoundingClientRect().height, `${label}: paint stays under 44px`).toBeLessThan(44);
  el.scrollIntoView({ block: "center" });
  expect(edgeOwners(el, coarsePointer() ? 44 : 0), `${label}: owns each edge of its target`).toEqual(OWNED);
}

function Broken(): ReactNode { throw new TypeError("The raft came apart"); }

for (const width of [320, 1280]) {
  test(`worker host notice at ${width}`, async ctx => {
    const s = await mount(ctx, width, async url => url.endsWith("/api/status")
      ? Response.json({ healthy: true, runtime: { boot: [], workerHost: { ordinary: { available: false, requirement: "bubblewrap", checkedAt: "2026-07-12T08:00:00.000Z", trigger: "boot" } } } })
      : Response.json({}));
    s.draw(<div style={{ padding: 16 }}><WorkerHostNotice /></div>);
    await expect.poll(() => button("Check again").elements().length).toBe(1);
    reach(s.host, "worker host notice");
  });
  test(`graph node card actions at ${width}`, async ctx => {
    const s = await mount(ctx, width, offline);
    s.draw(<div style={{ padding: 16, maxWidth: 360 }}><NodeCard kind="goal" title="Return to Ithaca" path="voyage/return.md" inDegree={3} outDegree={2} distance={1}
      canOpen canFocus canExpand expandName="Expand Return to Ithaca" expandReason="Expansion stopped at the band limit." expandError="Expansion failed."
      onOpen={noop} onFocus={noop} onExpand={noop} onRetry={noop} onClose={noop} /></div>);
    await expect.poll(() => button("Open note").elements().length).toBe(1);
    reach(s.host, "node card");
  });
  test(`file viewer failure and binary download at ${width}`, async ctx => {
    const s = await mount(ctx, width, offline);
    s.draw(<>
      <ViewerFailure failure={{ kind: "unreachable" }} onRetry={noop} />
      <FileViewerBinary content={{ path: "voyage/ithaca-chart.bin", kind: "binary", size: 4096, mtime: Date.UTC(2026, 6, 12), mime: "application/octet-stream" }} />
    </>);
    await expect.poll(() => button("Try again").elements().length).toBe(1);
    reach(s.host, "file viewer");
    const download = [...s.host.querySelectorAll<HTMLElement>("a[download]")].find(a => a.textContent?.includes("Download") && a.classList.contains("rounded-md"));
    expect(download, "the bordered binary download renders").toBeDefined();
    rawReach(download!, describeHit(download!));
  });
  test(`page failure actions at ${width}`, async ctx => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    ctx.onTestFinished(() => { vi.restoreAllMocks(); });
    const s = await mount(ctx, width, offline);
    s.ui.stores.ui.getState().setActiveView("graph");
    s.draw(<PageBoundary reload={noop}><Broken /></PageBoundary>);
    await expect.poll(() => button("Go to Chat").elements().length).toBe(1);
    reach(s.host, "page failure");
  });
  test(`diagnostic review actions at ${width}`, async ctx => {
    const s = await mount(ctx, width, offline);
    s.draw(<DiagnosticReview mode="report" initialBody="The Ithaca route failed." defaultIssueTitle="Ithaca route" title={{ initial: "Ithaca route" }}
      inclusions={[{ id: "failure", label: "Include failure text", build: () => "Charybdis took the mast" }]} onClose={noop} />);
    await expect.poll(() => button("Copy").elements().length).toBe(1);
    reach(page.getByRole("dialog").element(), "diagnostic review");
  });
}
