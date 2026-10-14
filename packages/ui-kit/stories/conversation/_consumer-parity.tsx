import { useLayoutEffect, useState, type ReactNode } from "react";
import { expect } from "storybook/test";
import axe from "axe-core";
import { flushSync } from "react-dom";

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
    const restore = () => { style.remove(); for (const { sheet, disabled } of sheets) sheet.disabled = disabled; fixtureCleanups.delete(cleanup); };
    const cleanup = () => { flushSync(() => setMounted(false)); restore(); };
    fixtureCleanups.add(cleanup);
    return restore;
  }, []);
  return <main style={{ padding: 16, maxWidth: 900, color: "var(--bk-color-ink)", background: "var(--bk-color-canvas)" }}>{mounted && children}</main>;
}

/** Loaded only in the browser test runner, leaving stories portable in dev. */
export async function consumerViewport({ args }: { args: { width: number } }) {
  if (!document.documentElement.dataset.expectedStoryTheme) return;
  const { page, commands } = await import("vitest/browser");
  const before = { width: innerWidth, height: innerHeight };
  const outer = await commands.consumerParityViewport(args.width);
  try { await page.viewport(args.width, 800); }
  catch (error) { await commands.consumerParityViewport(null, outer); throw error; }
  let restored = false;
  const cleanup = async () => {
    if (restored) return;
    restored = true;
    for (const dispose of [...fixtureCleanups]) dispose();
    try { await page.viewport(before.width, before.height); }
    finally { await commands.consumerParityViewport(null, outer); }
  };
  // Storybook's portable run cleans before the next story. Vitest's finalizer
  // also cleans the last/failed story immediately, after its a11y afterEach.
  const { onTestFinished } = await import("vitest");
  onTestFinished(cleanup);
  return cleanup;
}

export async function painted(width: number, theme: string | undefined) {
  await expect(innerWidth, "actual consumer viewport").toBe(width);
  await expect(matchMedia("(min-width: 900px)").matches, "actual pane media query").toBe(width >= 900);
  await expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
  await expect(document.querySelectorAll("style[data-consumer-parity]")).toHaveLength(1);
  await expect(getComputedStyle(document.documentElement).colorScheme, "consumer document paints the selected theme").toBe(theme);
  const probe = document.createElement("div");
  probe.className = "p-4";
  document.body.append(probe);
  try { await expect(getComputedStyle(probe).padding, "consumer Tailwind scale owns the document").toBe("16px"); }
  finally { probe.remove(); }
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
  for (const control of controls) {
    const box = control.getBoundingClientRect();
    await expect(box.height, `${label}: ${control.textContent} target height`).toBeGreaterThanOrEqual(44);
    await expect(box.width, `${label}: ${control.textContent} target width`).toBeGreaterThanOrEqual(44);
  }
}

/** Check each transient state too; the unchanged addon gate also checks the
 * final rendered state in both projects. No rules or contrast are disabled. */
export async function accessible(element: HTMLElement) {
  const result = await axe.run(element, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } });
  await expect(result.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) }))).toEqual([]);
}
