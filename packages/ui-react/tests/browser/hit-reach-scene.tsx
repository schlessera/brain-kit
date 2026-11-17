/**
 * The scene harness for the #3252 edge probes (`hit-reach.*.pointer.tsx`).
 *
 * `mount` draws a consumer scene at a width under the project's native pointer
 * premise, with the consumer stylesheet and no motion. `reach` checks both
 * halves of the rule on that scene: no kit Button draws a 44px box, every
 * enabled Button under 44px reaches 44px under a coarse pointer, and every
 * enabled control owns `elementFromPoint` 1px inside each edge of its target.
 */
import { expect, inject, vi, type TestContext } from "vitest";
import { commands, page } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot } from "../../src/root.js";
import { OWNED, coarsePointer, describeHit, probeScope, targetRect } from "./hit-reach.js";

export function premise() {
  const mode = inject("railPointer");
  expect(matchMedia("(any-pointer: coarse)").matches, "native coarse pointer premise").toBe(mode !== "fine");
  return mode;
}

export async function mount(ctx: TestContext, width: number, request: (url: string, init?: RequestInit) => Promise<Response>) {
  premise();
  const viewport = { width: innerWidth, height: innerHeight };
  const theme = document.documentElement.dataset.theme;
  const outer = await commands.formViewport(width, 800);
  await page.viewport(width, 800);
  document.documentElement.dataset.theme = "dark";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2026, 6, 12, 9, 41));
  const style = document.createElement("style");
  style.textContent = await commands.formConsumerStyles();
  style.textContent += "\n*,*::before,*::after{animation:none!important;transition:none!important}";
  document.head.append(style);
  const host = document.createElement("div");
  host.style.cssText = `width:${width}px;background:var(--bk-color-canvas);color:var(--bk-color-ink)`;
  document.body.append(host);
  const ui = createBrainUiRoot({ storage: null, request: async (url, init) => request(String(url), init) });
  const renderer = createRoot(host);
  ctx.onTestFinished(async () => {
    flushSync(() => renderer.unmount()); ui.dispose(); host.remove(); style.remove();
    vi.useRealTimers();
    if (theme === undefined) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
    await page.viewport(viewport.width, viewport.height);
    await commands.formViewport(outer.width - 100, outer.height - 120);
  });
  const draw = (children: ReactNode) => flushSync(() => renderer.render(<BrainUiProvider root={ui}>{children}</BrainUiProvider>));
  return { host, ui, draw };
}

/** Both halves of the rule, for one rendered scene. */
export function reach(scope: ParentNode, label: string) {
  const buttons = [...scope.querySelectorAll<HTMLElement>("[data-bk-button][role=button]")];
  expect(buttons.length, `${label}: the scene renders Buttons`).toBeGreaterThan(0);
  const inflated = buttons.filter(button => button.style.minHeight === "44px").map(describeHit);
  expect(inflated, `${label}: no Button draws a 44px box to reach 44px`).toEqual([]);
  if (coarsePointer()) {
    // Without this the edge probe passes vacuously: a Button with no reach is
    // probed at its paint. Under a coarse pointer every enabled Button whose
    // paint is under 44px must reach, and must reach 44px.
    const enabled = buttons.filter(button => button.getAttribute("aria-disabled") !== "true");
    const unreached = enabled.filter(button => { const r = button.getBoundingClientRect(); return !button.classList.contains("bk-hit") && (r.height < 44 || r.width < 44); }).map(describeHit);
    expect(unreached, `${label}: no enabled Button stays under 44px`).toEqual([]);
    const short = enabled.filter(button => button.classList.contains("bk-hit"))
      .filter(button => { const t = targetRect(button, 44); return t.width < 44 || t.height < 44; }).map(describeHit);
    expect(short, `${label}: every reaching Button reaches 44px`).toEqual([]);
  }
  const stolen = probeScope(scope).filter(row => JSON.stringify(row.owners) !== JSON.stringify(OWNED));
  expect(stolen, `${label}: every control owns each edge of its target`).toEqual([]);
}
