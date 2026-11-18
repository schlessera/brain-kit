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
import { ViewerFailure, ViewerToolbar } from "../../src/components/files/file-viewer-frame.js";
import { GraphControlsColumn } from "../../src/components/graph/graph-controls-column.js";
import { ControlsBody } from "../../src/components/graph/graph-controls.js";
import { IconButton, TextButton } from "@schlessera/brain-ui-kit";
import { Share2 } from "lucide-react";
import { FileViewerBinary } from "../../src/components/files/file-viewer-binary.js";
import { PageBoundary } from "../../src/components/layout/page-boundary.js";
import { DiagnosticReview } from "../../src/components/report/diagnostic-review.js";
import { coarsePointer, describeHit, edgeOwners, OWNED, probeScope, touchFloor } from "./hit-reach.js";
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

/**
 * #4086 (ruled on #3531): every interactive FilterRow pill in the scope keeps
 * its 20.5px kit paint, carries `.bk-hit` and meets the touch floor, and no
 * control in the scope loses an edge to a reach. `clipped` names pills the
 * strip already cuts off horizontally, which hold only to their visible part.
 */
function tabsReach(scope: HTMLElement, label: string, clipped: string[] = []) {
  const tabs = [...scope.querySelectorAll<HTMLElement>('[role="tab"]')];
  expect(tabs.length, `${label}: renders FilterRow pills`).toBeGreaterThan(1);
  const cut = tabs.filter((tab) => {
    const strip = tab.parentElement!.getBoundingClientRect(), box = tab.getBoundingClientRect();
    return box.right > strip.right + 0.5 || box.left < strip.left - 0.5;
  }).map((tab) => tab.textContent);
  expect(cut, `${label}: pills the strip cuts off`).toEqual(clipped);
  for (const tab of tabs.filter((t) => !clipped.includes(t.textContent ?? ""))) {
    const name = describeHit(tab);
    expect(tab.classList.contains("bk-hit"), `${name}: carries the hit-area utility`).toBe(true);
    expect(tab.getBoundingClientRect().height, `${name}: keeps the kit paint height`).toBeCloseTo(20.5, 0);
    expect(touchFloor(tab), `${name}: meets the touch floor`).toBe("met");
  }
  const stolen = probeScope(scope).filter((row) => !clipped.some((c) => row.name.includes(`"${c}"`)) && JSON.stringify(row.owners) !== JSON.stringify(OWNED));
  expect(stolen, `${label}: every control owns each edge of its target`).toEqual([]);
}

const toolbar = (share: boolean) => (
  <ViewerToolbar fileName="the-long-voyage-home-from-troy-to-ithaca.md" fullPath="voyage/the-long-voyage-home-from-troy-to-ithaca.md" size={4200}
    mode="preview" previewAvailable copied={false} onMode={noop} onCopyPath={noop} onReveal={noop}
    // The toolbar's real untrusted-mark control (an md IconButton) and its
    // "couldn't check" cue, whose inline Retry is the one reaching control
    // that can sit on the line above a wrapped Preview/Raw row.
    untrusted={<IconButton size="md" name="Mark untrusted" glyph={<Share2 className="h-3.5 w-3.5" />} onClick={noop} />}
    untrustedCue={<div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground"><span>Couldn't check the untrusted mark</span><TextButton tone="link" label="Retry" onClick={noop} /></div>}
    share={share ? <IconButton size="md" name="Share" glyph={<Share2 className="h-3.5 w-3.5" />} onClick={noop} /> : null} />
);

for (const width of [320, 1280]) {
  for (const share of [true, false]) test(`file viewer toolbar ${share ? "with" : "without"} Share at ${width}`, async ctx => {
    const s = await mount(ctx, width, offline);
    s.draw(toolbar(share));
    await expect.poll(() => page.getByRole("tab", { name: "Raw" }).elements().length).toBe(1);
    if (width === 320) {
      // The narrow toolbar wraps: Preview/Raw sits on a line of its own below.
      const reveal = page.getByRole("button", { name: "Reveal in tree" }).element().getBoundingClientRect();
      const raw = page.getByRole("tab", { name: "Raw" }).element().getBoundingClientRect();
      expect(raw.top, "Preview/Raw wraps below the first line at 320px").toBeGreaterThan(reveal.bottom);
    }
    tabsReach(s.host, "viewer toolbar");
  });
  // Local mode draws the Direction and Colour rows, Clusters mode Node size.
  for (const [mode, pill] of [["local", "In"], ["clusters", "PageRank"]] as const) test(`graph ${mode} controls at ${width}`, async ctx => {
    const s = await mount(ctx, width, offline);
    s.ui.stores.graph.getState().setMode(mode);
    // The laptop column, and the same form at phone width in the sheet.
    // #4092: the 264px column cuts "Maintenance" (and in Local mode "Entity")
    // off; they hold only to their visible part.
    s.draw(width === 1280 ? <div style={{ display: "flex", height: 760 }}><GraphControlsColumn /></div> : <div style={{ padding: 16 }}><ControlsBody /></div>);
    await expect.poll(() => page.getByRole("tab", { name: pill, exact: true }).elements().length).toBe(1);
    tabsReach(s.host, `graph ${mode} controls`, width === 1280 ? (mode === "local" ? ["Maintenance", "Entity"] : ["Maintenance"]) : []);
  });
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
