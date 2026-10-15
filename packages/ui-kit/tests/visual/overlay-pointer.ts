/// <reference types="@vitest/browser-playwright" />
import type { BrowserCommand } from "vitest/node";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * A real mouse click at a frame point. Playwright's locator click waits for
 * an `aria-disabled` control to become enabled, so it can never prove that a
 * disabled chip ignores a click; the mouse has no such precondition.
 */
export const overlayMouse: BrowserCommand<[{ x: number; y: number }]> = async (ctx, point) => {
  const frame = await ctx.frame();
  const element = await frame.frameElement();
  const bounds = await element.boundingBox();
  if (!bounds) throw new Error("Overlay test frame has no painted bounds");
  const viewport = await frame.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  // Vitest scales its iframe when the viewport is larger than the host.
  const x = point.x * (bounds.width / viewport.width) + bounds.x;
  const y = point.y * (bounds.height / viewport.height) + bounds.y;
  await ctx.page.mouse.click(x, y);
};

declare module "vitest/browser" {
  interface BrowserCommands {
    overlayMouse(point: { x: number; y: number }): Promise<void>;
  }
}

/** Compare actual navigation paint with and without destination effects.
 * The active tab/focus stay identical; shadows are absent from hit testing. */
export const destinationPaint: BrowserCommand<[string, string, string], { same: boolean; stable: boolean }> = async (ctx, navigation, panel, label) => {
  if (!/^[a-zA-Z0-9-]+$/.test(label)) throw new Error("Invalid destination paint label");
  const nav = ctx.iframe.locator(navigation);
  const overlay = ctx.iframe.locator(panel);
  // This crop has no editable field. Playwright's default caret hiding mutates
  // inputs outside it and alternates an LCD glyph-edge pixel in the tab labels
  // (#1910), even in consecutive captures with unchanged overlay visibility.
  // Keep the real opening animations and exact byte comparison intact.
  const painted = await nav.screenshot({ animations: "allow", caret: "initial" });
  const paintedAgain = await nav.screenshot({ animations: "allow", caret: "initial" });
  const visibility = await overlay.evaluate(element => {
    const node = element as HTMLElement;
    const value = node.style.visibility;
    node.style.visibility = "hidden";
    return value;
  });
  try {
    const clear = await nav.screenshot({ animations: "allow", caret: "initial" });
    const clearAgain = await nav.screenshot({ animations: "allow", caret: "initial" });
    const same = painted.equals(clear);
    const stable = painted.equals(paintedAgain) && clear.equals(clearAgain);
    if (!same || !stable || /^dark-320-(Sessions|Files)-0$/.test(label)) {
      // Collect diagnostics only after the original comparison. Reading layout
      // or writing files between successful captures can change the race.
      const afterComparison = await nav.evaluate((nav, panelSelector) => {
        const describe = (element: Element) => {
          const css = getComputedStyle(element);
          return {
            tag: element.tagName, class: element.className,
            text: element.textContent?.slice(0, 100),
            rect: element.getBoundingClientRect().toJSON(),
            transform: css.transform, opacity: css.opacity, visibility: css.visibility,
            color: css.color, background: css.backgroundColor, font: css.font,
            hovered: element.matches(":hover"), focused: element.matches(":focus"),
          };
        };
        return {
          now: performance.now(), viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
          navigation: describe(nav), panel: describe(document.querySelector(panelSelector)!),
          tabs: [...nav.querySelectorAll('[role="tab"]')].map(describe),
          active: document.activeElement?.outerHTML.slice(0, 1000),
          fonts: { status: document.fonts.status, faces: [...document.fonts].map(f => ({ family: f.family, weight: f.weight, status: f.status })) },
          animations: document.getAnimations().slice(0, 64).map(a => ({
            time: a.currentTime, state: a.playState,
            target: describe((a.effect as KeyframeEffect).target as Element),
            timing: a.effect?.getComputedTiming(),
          })),
        };
      }, panel);
      const directory = resolve(".vitest-attachments/destination-paint", `${ctx.project.name.replace(/[^a-z0-9-]/gi, "-")}-${label}`);
      await mkdir(directory, {recursive: true});
      await writeFile(resolve(directory, "painted.png"), painted);
      await writeFile(resolve(directory, "painted-again.png"), paintedAgain);
      await writeFile(resolve(directory, "clear.png"), clear);
      await writeFile(resolve(directory, "clear-again.png"), clearAgain);
      await writeFile(resolve(directory, "state.json"), JSON.stringify({ label, same, stable, navigation, panel, paintedBytes: painted.length, clearBytes: clear.length, afterComparison }, null, 2));
    }
    return { same, stable };
  } finally {
    await overlay.evaluate((element, value) => { (element as HTMLElement).style.visibility = value; }, visibility);
  }
};

/** Exercise Chromium's real env() values, rather than replacing CSS geometry. */
export const destinationSafeArea: BrowserCommand<[number], void> = async (ctx, bottom) => {
  const session = await ctx.page.context().newCDPSession(ctx.page);
  try { await session.send("Emulation.setSafeAreaInsetsOverride", { insets: { bottom } }); }
  finally { await session.detach(); }
};

declare module "vitest/browser" {
  interface BrowserCommands {
    destinationPaint(navigation: string, panel: string, label: string): Promise<{ same: boolean; stable: boolean }>;
    destinationSafeArea(bottom: number): Promise<void>;
  }
}
