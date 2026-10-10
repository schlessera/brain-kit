/**
 * The logo in the app's own screens (#1426): the desktop side rail's wordmark,
 * the login screen and the empty chat show `BrandMark`, not the lucide Brain
 * stand-in, in both themes. The assertions before each baseline fail by name
 * if the mark is missing, named, or a heading loses its accessible name.
 *
 * The rail is captured as its wordmark row alone. The rail's whole-screen
 * subject baselines allow 0.1% of 900x600 pixels to differ, more than a 20px
 * glyph swap paints, so they cannot tell the logo from the stand-in.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { commands, page } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { SideRail } from "@schlessera/brain-ui-kit";
import { LoginForm } from "../../src/components/connectivity/login-form.js";
import { WelcomeState } from "../../src/components/chat/welcome-state.js";

let renderer: Root | undefined, host: HTMLDivElement | undefined;
let styles: HTMLStyleElement, viewport: { width: number; height: number };
const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

beforeAll(async () => {
  viewport = { width: innerWidth, height: innerHeight };
  styles = document.createElement("style");
  styles.textContent = await commands.formConsumerStyles();
  document.head.append(styles);
});
afterAll(() => styles.remove());
afterEach(async () => {
  if (renderer) flushSync(() => renderer!.unmount());
  host?.remove();
  renderer = undefined;
  host = undefined;
  document.documentElement.dataset.theme = "dark";
  await page.viewport(viewport.width, viewport.height);
});

async function mount(width: number, theme: string, node: ReactNode, animated = true) {
  await page.viewport(width, 720);
  document.documentElement.dataset.theme = theme;
  host = document.createElement("div");
  host.style.cssText = `width:${width}px;height:720px;overflow:hidden;background:var(--bk-color-canvas)`;
  document.body.append(host);
  renderer = createRoot(host);
  flushSync(() => renderer!.render(node));
  await document.fonts.ready;
  await settle();
  await settle();
  // framer-motion fades both screens in; wait for the end state before measuring.
  if (animated) await expect.poll(() => getComputedStyle(host!.firstElementChild!.firstElementChild!).opacity).toBe("1");
}

/**
 * The one logo in `scope`: drawn from the kit, decorative, and with no lucide
 * Brain beside it. (The rail's Chat destination keeps lucide Brain as its
 * navigation glyph, per #1423, so the rail is scoped to its wordmark row.)
 */
function decorativeMark(scope: HTMLElement = host!) {
  const marks = scope.querySelectorAll<SVGSVGElement>("svg[data-brand-mark]");
  expect(marks).toHaveLength(1);
  expect(marks[0]!.getAttribute("aria-hidden")).toBe("true");
  expect(marks[0]!.getBoundingClientRect().height).toBeGreaterThan(0);
  expect(scope.querySelector(".lucide-brain"), "no lucide Brain stand-in").toBeNull();
  return marks[0]!;
}

for (const width of [320, 1280]) {
  for (const theme of ["dark", "light"]) {
    test(`login ${theme} ${width}: the logo sits beside a heading that keeps its name`, async () => {
      await mount(width, theme, (
        <LoginForm appName="Ithaca" methods={{ password: true, passkey: true }} password="" busy={false} error={null}
          onPasswordChange={() => {}} onPassword={() => {}} onPasskey={() => {}} />
      ));
      expect(decorativeMark().dataset.brandMark).toBe("mark");
      expect(page.getByRole("heading", { name: "Ithaca" }).elements()).toHaveLength(1);
      await expect(page.elementLocator(host!)).toMatchScreenshot(`brand-login-${theme}-${width}`);
    });

    test(`welcome ${theme} ${width}: the empty chat shows the logo`, async () => {
      await mount(width, theme, <WelcomeState onAction={() => {}} />);
      expect(decorativeMark().dataset.brandMark).toBe("mark");
      expect(page.getByRole("heading", { name: "What do you need to know?" }).elements()).toHaveLength(1);
      await expect(page.elementLocator(host!)).toMatchScreenshot(`brand-welcome-${theme}-${width}`);
    });
  }
}

for (const theme of ["dark", "light"]) {
  for (const expanded of [true, false]) {
    test(`side rail ${expanded ? "expanded" : "collapsed"} ${theme}: the wordmark tile holds the logo`, async () => {
      await mount(1280, theme, <SideRail expanded={expanded} />, false);
      const row = host!.querySelector<HTMLElement>(".bk-side-rail > :first-child")!;
      // Below 24px the kit draws the small-size master.
      expect(decorativeMark(row).dataset.brandMark).toBe("small");
      await expect(page.elementLocator(row)).toMatchScreenshot(`brand-rail-${expanded ? "expanded" : "collapsed"}-${theme}`);
    });
  }
}
