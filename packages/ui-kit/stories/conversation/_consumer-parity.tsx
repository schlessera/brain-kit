import { useLayoutEffect, useState, type ReactNode } from "react";
import { expect } from "storybook/test";
import axe from "axe-core";
import { flushSync } from "react-dom";
import { consumerViewportKey } from "../_viewports.js";

const fixtureCleanups = new Set<() => void>();
import consumerStyles from "../../../ui-react/dist/styles.css?raw";

/** These fixtures own the story document, including native top-layer dialogs.
 * Keep the pinned font sheet, but prevent kit Tailwind utilities from masking
 * missing consumer rules. Storybook unmounts each story before the next one. */
export function ConsumerDocument({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(true);
  useLayoutEffect(() => {
    if (fixtureCleanups.size) throw new Error("Consumer stories cannot share a document concurrently");
    const sheets = [...document.styleSheets].filter(sheet => {
      const node = sheet.ownerNode as HTMLElement | null;
      return node?.getAttribute("data-vite-dev-id")?.match(/(?:ui-kit\/src\/styles\.css|\.storybook\/preview\.css)$/);
    }).map(sheet => ({ sheet, disabled: sheet.disabled }));
    for (const { sheet } of sheets) sheet.disabled = true;
    const style = document.createElement("style");
    style.dataset.consumerParity = "";
    style.textContent = consumerStyles;
    document.head.append(style);
    const restore = () => {
      const errors: unknown[] = [];
      try { style.remove(); } catch (error) { errors.push(error); }
      for (const { sheet, disabled } of sheets) {
        try { sheet.disabled = disabled; } catch (error) { errors.push(error); }
      }
      fixtureCleanups.delete(cleanup);
      if (errors.length) throw new AggregateError(errors, "Consumer stylesheet restoration failed");
    };
    const cleanup = () => {
      const errors: unknown[] = [];
      try { flushSync(() => setMounted(false)); } catch (error) { errors.push(error); }
      try { restore(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Consumer document cleanup failed");
    };
    fixtureCleanups.add(cleanup);
    return restore;
  }, []);
  return <main style={{ padding: 16, maxWidth: 900, color: "var(--bk-color-ink)", background: "var(--bk-color-canvas)" }}>{mounted && children}</main>;
}

/** The Vitest runner sets this; opened by hand, a story runs without it. */
const inRunner = () => Boolean(document.documentElement.dataset.expectedStoryTheme);

/** Loaded only in the browser test runner, leaving stories portable in dev. */
export async function consumerViewport({ args, globals }: { args: { width: number }; globals?: { viewport?: unknown } }) {
  if (!inRunner()) return;
  // A story's width must also open it at that width by hand (#3749): one
  // without the matching viewport global renders the desktop layout in the
  // Storybook UI whatever its width says. Pair them with `atWidth()`.
  const viewport = (globals?.viewport as { value?: string } | undefined)?.value;
  await expect(viewport, `width ${args.width} opens at its own viewport (atWidth/viewportAt)`).toBe(consumerViewportKey(args.width));
  const { page, commands } = await import("vitest/browser");
  const { onTestFinished } = await import("vitest");
  const before = { width: innerWidth, height: innerHeight };
  const outer = await commands.consumerParityViewport(args.width);
  let restored = false;
  const cleanup = async () => {
    if (restored) return;
    restored = true;
    const errors: unknown[] = [];
    for (const dispose of [...fixtureCleanups]) {
      try { dispose(); } catch (error) { errors.push(error); }
    }
    try { await page.viewport(before.width, before.height); } catch (error) { errors.push(error); }
    try { await commands.consumerParityViewport(null, outer); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Consumer viewport cleanup failed");
  };
  // Register before resizing: a rejected resize can still have changed the
  // iframe. Always attempt both viewport restorations and every fixture.
  onTestFinished(cleanup);
  try { await page.viewport(args.width, 800); }
  catch (error) {
    try { await cleanup(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Consumer viewport setup and cleanup failed");
    }
    throw error;
  }
  // Storybook cleans before the next story; the finalizer also cleans the
  // last/failed story immediately, after its unchanged a11y afterEach.
  return cleanup;
}

/**
 * `ui-react`'s compiled stylesheet owns the document. A story that renders a
 * `ui-react` component without `ConsumerDocument` has none of its Tailwind
 * utilities, and paints a dialog or a turn header as bare markup (#3748).
 */
export async function consumerStyled() {
  await expect(document.querySelectorAll("style[data-consumer-parity]"), "the consumer stylesheet is loaded once").toHaveLength(1);
  const probe = document.createElement("div");
  probe.className = "p-4";
  document.body.append(probe);
  try { await expect(getComputedStyle(probe).padding, "consumer Tailwind scale owns the document").toBe("16px"); }
  finally { probe.remove(); }
}

export async function painted(width: number, theme: string | undefined) {
  // The exact viewport and the reduced-motion emulation exist only in the
  // runner. Opened by hand, the story's viewport global sets the width and
  // the browser's own motion setting applies, so asserting them there would
  // only report a failure nobody can act on.
  if (inRunner()) {
    await expect(innerWidth, "actual consumer viewport").toBe(width);
    await expect(matchMedia("(min-width: 900px)").matches, "actual pane media query").toBe(width >= 900);
    await expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
  }
  await consumerStyled();
  await expect(getComputedStyle(document.documentElement).colorScheme, "consumer document paints the selected theme").toBe(theme ?? "dark");
}

export async function bounds(element: HTMLElement, label: string) {
  const box = element.getBoundingClientRect();
  await expect(box.width, `${label} is painted`).toBeGreaterThan(0);
  await expect(box.left, `${label} left bound`).toBeGreaterThanOrEqual(-1);
  await expect(box.right, `${label} right bound`).toBeLessThanOrEqual(innerWidth + 1);
  await expect(element.scrollWidth, `${label} content bounds`).toBeLessThanOrEqual(element.clientWidth + 1);
  await expect(document.documentElement.scrollWidth, `${label} document bounds`).toBeLessThanOrEqual(innerWidth);
}

export async function targets(element: HTMLElement, label: string) {
  const controls = [...element.querySelectorAll<HTMLElement>('button,[role="button"],[role="checkbox"],select')];
  await expect(controls.length, `${label} has real controls`).toBeGreaterThan(0);
  for (const control of controls) await target(control, `${label}: ${control.textContent}`);
}

/** One control's 44px target. A reaching control (`.bk-hit`, #3252) keeps its
 * kit paint and reaches 44px past it under a coarse pointer; a fine pointer has
 * no 44px floor. Its edges are probed in ui-react's hit-reach pointer tests. Any
 * other control must paint the 44px box itself. */
export async function target(control: HTMLElement, label: string) {
  if (control.classList.contains("bk-hit")) {
    await expect(control.style.minHeight, `${label} is not inflated`).not.toBe("44px");
    if (matchMedia("(any-pointer: coarse)").matches) {
      await expect(getComputedStyle(control, "::after").position, `${label} reach is active`).toBe("absolute");
    }
    return;
  }
  const box = control.getBoundingClientRect();
  await expect(box.height, `${label} target height`).toBeGreaterThanOrEqual(44);
  await expect(box.width, `${label} target width`).toBeGreaterThanOrEqual(44);
}

/** Check each transient state too; the unchanged addon gate also checks the
 * final rendered state in both projects. No rules or contrast are disabled. */
export async function accessible(element: HTMLElement) {
  const result = await axe.run(element, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } });
  await expect(result.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) }))).toEqual([]);
}
