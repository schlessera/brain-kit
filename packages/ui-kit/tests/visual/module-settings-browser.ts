/// <reference types="@vitest/browser-playwright" />
import type { BrowserCommand } from "vitest/node";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const fixtureOwner = /^[a-z0-9-]+$/;

/** Capture only the calling case's fixture. A timed-out Vitest callback keeps
 * running, so a page holding any other module-settings fixture is a leak to
 * report, never something to resolve by picking one of the iframes (#2440). */
export const moduleSettingsScreenshot: BrowserCommand<[string, string], void> = async (ctx, owner, name) => {
  if (!fixtureOwner.test(owner)) throw new Error("Invalid module settings fixture owner");
  if (!/^[a-z-]+$/.test(name)) throw new Error("Invalid screenshot name");
  const directory = resolve("../../.vitest-attachments/module-settings");
  await mkdir(directory, { recursive: true });
  const frame = await ctx.frame();
  const fixtures = await frame.locator("iframe[data-module-settings]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-module-settings") ?? ""));
  if (fixtures.length !== 1 || fixtures[0] !== owner) {
    throw new Error(`Module settings capture ${name} belongs to ${owner}, but the page holds fixtures [${fixtures.join(", ")}]`);
  }
  const element = await frame.frameElement();
  const styles = await element.evaluate((element) => {
    if (!(element instanceof HTMLElement)) throw new Error("Test frame is not an HTML element");
    const styles: Array<string | null> = [];
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      styles.push(node.getAttribute("style"));
    }
    element.style.transform = "none";
    element.style.transformOrigin = "top left";
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (getComputedStyle(parent).transform !== "none") parent.style.transform = "none";
      parent.style.overflow = "visible";
    }
    return styles;
  });
  try {
    await frame.locator(`iframe[data-module-settings="${owner}"]`).screenshot({ path: resolve(directory, `${name}.png`) });
  } finally {
    await element.evaluate((element, styles) => {
      if (!(element instanceof HTMLElement)) throw new Error("Test frame is not an HTML element");
      let index = 0;
      for (let node: Element | null = element; node; node = node.parentElement) {
        const style = styles[index++];
        if (style == null) node.removeAttribute("style");
        else node.setAttribute("style", style);
      }
    }, styles);
  }
};
declare module "vitest/browser" {
  interface BrowserCommands { moduleSettingsScreenshot(owner: string, name: string): Promise<void>; }
}

type ImportGate = {
  owner: string;
  arrived: Promise<void>;
  release(): void;
  finished: Promise<void>;
  requests: number;
  timer?: ReturnType<typeof setTimeout>;
};
const importGates = new WeakMap<object, ImportGate>();
const moduleImportPattern = "**/modules-tab.*";

/** Exercise the actual cold lazy import, independently of the data/DOM poll. */
export const moduleSettingsImportGate: BrowserCommand<[string, "hold" | "arrived" | "release" | "stop"], number> = async (ctx, owner, action) => {
  if (!fixtureOwner.test(owner)) throw new Error("Invalid module settings fixture owner");
  if (action === "hold") {
    if (importGates.has(ctx.page)) throw new Error(`Module import gate is already installed by ${importGates.get(ctx.page)!.owner}`);
    let arrived!: () => void;
    let release!: () => void;
    let finished!: () => void;
    const gate: ImportGate = {
      owner,
      arrived: new Promise<void>((resolve) => { arrived = resolve; }),
      release: () => release(),
      finished: new Promise<void>((resolve) => { finished = resolve; }),
      requests: 0,
    };
    const held = new Promise<void>((resolve) => { release = resolve; });
    importGates.set(ctx.page, gate);
    await ctx.page.route(moduleImportPattern, async (route) => {
      gate.requests++;
      arrived();
      try {
        await held;
        await route.continue();
      } finally { finished(); }
    });
    return 0;
  }
  const gate = importGates.get(ctx.page);
  if (!gate) {
    if (action === "stop") return 0;
    throw new Error("Module import gate is not installed");
  }
  if (gate.owner !== owner) throw new Error(`Module import gate belongs to ${gate.owner}, not ${owner}`);
  if (action === "arrived") await gate.arrived;
  if (action === "release") {
    // Longer than the unchanged 1000ms DOM poll. Removing the import await
    // must fail that poll even on an otherwise idle, cached Vite server.
    gate.timer = setTimeout(gate.release, 1200);
  }
  if (action === "stop") {
    clearTimeout(gate.timer);
    gate.release();
    if (gate.requests) await gate.finished;
    await ctx.page.unroute(moduleImportPattern);
    importGates.delete(ctx.page);
  }
  return gate.requests;
};
declare module "vitest/browser" {
  interface BrowserCommands { moduleSettingsImportGate(owner: string, action: "hold" | "arrived" | "release" | "stop"): Promise<number>; }
}
