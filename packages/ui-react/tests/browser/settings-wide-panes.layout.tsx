/**
 * Wide Settings panes (#4538, #4537 D6). Storage, Models, Modules and Skills
 * opt in with `width="wide"` and grow to a 1200px pane cap; every other pane
 * keeps its 720px column. Inside a wide pane, prose keeps the 68ch reading
 * measure, and grids stack by the pane container's width (one column below
 * 560px, `auto-fill minmax(260px, 1fr)` from 560px), never by the viewport's.
 *
 * Every pane is captured at 320, 900, 1280 and 1440 in dark and paper. The
 * standard panes' baselines were recorded before the wide opt-in existed, so
 * they prove that the change left those panes pixel-identical.
 */
import { expect, test } from "vitest";
import { commands, page } from "vitest/browser";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot } from "../../src/root.js";
import type { SettingsTab } from "../../src/stores/ui-state.js";
import type { TrustSettingsRead } from "../../src/lib/trust-settings.js";
import { SettingsPanel } from "../../src/components/settings/settings-panel.js";
import { watchdogMs } from "../../../../scripts/test-deadlines.js";

const trustRead = {
  revision: "0", policyHash: null, error: null, rules: [], origins: [], repositories: [], mutationAllowed: false,
  capabilities: { originRules: true, recipientRules: true, repositoryRules: false, repositoryIdentity: false, readOnlyReason: null },
} satisfies TrustSettingsRead;

const crew = ["Penelope", "Telemachus", "Eurycleia", "Eumaeus", "Mentor", "Argos", "Philoetius", "Laertes", "Nausicaa", "Arete", "Alcinous", "Athena"];
const models = crew.map((name, i) => ({
  id: `ithaca/${name.toLowerCase()}`, label: `${name} ${i % 3 === 0 ? "large" : "swift"}`, provider: "ithaca", hidden: i % 5 === 4,
  contextWindow: (i % 4 + 1) * 64_000, source: i % 2 ? "declared" : "discovered", billingMode: i % 2 ? "subscription" : "api",
  ...(i % 3 === 0 ? { thinkingLevel: "medium", supportedThinkingLevels: ["low", "medium", "high"] } : {}),
}));
const skills = [
  { name: "voyage-log", description: "Keep the daily log of the voyage home, one entry per landfall.", source: "custom", enabled: true },
  { name: "suitor-ledger", description: "Track every suitor's claims on the household stores.", source: "custom", enabled: false },
  { name: "loom-plan", description: "Plan the shroud weaving that is undone each night.", source: "custom", enabled: true, warning: "SKILL.md has no description line" },
  ...["add-skill", "brain-search", "daily-note", "file-intake", "meeting-notes", "people", "projects", "weekly-review"].map(name => ({ name, description: `The built-in ${name} workflow for the household archive.`, source: "builtin", enabled: true })),
];
const modules = [
  ["council", "Prepare each council on Ithaca with its agenda, attendees and open questions."],
  ["household", "Stores, provisions and the accounts of the palace at Ithaca."],
  ["voyages", "Routes, landfalls and the crews of each ship."],
  ["correspondence", "Letters between Ithaca, Sparta and Pylos, filed by sender."],
  ["herds", "Eumaeus's count of the swine and the goats on the hills."],
].map(([name, description], i) => ({ name, key: name, description, state: i === 4 ? "dormant" : "active", settings: i !== 3 }));

function fixtures(path: string): Response {
  if (path === "/api/models") return Response.json({ models, customModels: ["openrouter/aeolus-winds", "openrouter/circe-isle"], defaultModelId: null, resolvedDefaultId: models[0]!.id, refreshedAt: null, stale: false, discovery: { enabled: false, error: "Ithaca harbour did not answer" } });
  if (path === "/api/skills") return Response.json({ skills });
  if (path === "/api/modules") return Response.json({ enabled: modules, available: [] });
  if (path === "/api/trust-settings") return Response.json(trustRead);
  if (path.startsWith("/api/storage")) return Response.json({ error: "Not configured" }, { status: 503 });
  if (path === "/api/agent-policy") return Response.json({ error: "Not configured" }, { status: 404 });
  return Response.json({ providers: [], configured: false, tools: [], principals: [], credentials: [], enabled: [], available: [] });
}

const PANES: Array<{ tab: SettingsTab; name: string; module?: () => Promise<unknown>; wide: boolean; grids: number; ready: string }> = [
  { tab: "appearance", name: "appearance", wide: false, grids: 0, ready: "Turning single-key shortcuts off" },
  { tab: "models", name: "models", module: () => import("../../src/components/settings/models-tab.js"), wide: true, grids: 2, ready: "openrouter/circe-isle" },
  { tab: "voice", name: "voice", module: () => import("../../src/components/settings/voice-tab.js"), wide: false, grids: 0, ready: "" },
  { tab: "accounts", name: "accounts", module: () => import("../../src/components/settings/accounts-tab.js"), wide: false, grids: 0, ready: "No other provider accounts" },
  { tab: "skills", name: "skills", module: () => import("../../src/components/settings/skills-tab.js"), wide: true, grids: 2, ready: "weekly-review" },
  { tab: "modules", name: "modules", module: () => import("../../src/components/settings/modules-tab.js"), wide: true, grids: 1, ready: "Herds" },
  { tab: "storage", name: "storage", module: () => import("../../src/components/settings/storage-tab.js"), wide: true, grids: 0, ready: "Storage" },
  { tab: "security", name: "security", module: () => import("../../src/components/settings/passkey-tab.js"), wide: false, grids: 0, ready: "No rules configured." },
  { tab: "devices", name: "devices", module: () => import("../../src/components/settings/devices-agents-tab.js"), wide: false, grids: 0, ready: "" },
];

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

/** Mount the shell at a CSS viewport and wait until the pane's requests are answered. */
async function mount(ctx: { onTestFinished: (fn: () => Promise<void>) => void }, pane: (typeof PANES)[number], width: number, height: number, theme: "dark" | "light") {
  const before = { width: innerWidth, height: innerHeight, theme: document.documentElement.dataset.theme };
  const outer = await commands.formViewport(width, height);
  await page.viewport(width, height);
  document.documentElement.dataset.theme = theme;
  const style = document.createElement("style"); style.textContent = await commands.formConsumerStyles(); document.head.append(style);
  const host = document.createElement("div"); host.dataset.buttonGallery = ""; host.style.cssText = `width:${width}px;height:${height}px;overflow:hidden;background:var(--bk-color-canvas)`;
  document.body.append(host);
  let pending = 0;
  const ui = createBrainUiRoot({ storage: null, request: async url => {
    pending++;
    try { return fixtures(new URL(String(url), "http://fixture.invalid").pathname); } finally { pending--; }
  } });
  ui.stores.ui.setState({ theme });
  ui.stores.ui.getState().openSettings(pane.tab);
  const react = createRoot(host);
  ctx.onTestFinished(async () => {
    flushSync(() => react.unmount()); ui.dispose(); host.remove(); style.remove();
    if (before.theme === undefined) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = before.theme;
    await page.viewport(before.width, before.height); await commands.formViewport(outer.width - 100, outer.height - 120);
  });
  // Explicit imports isolate cold transforms from the bounded DOM polls.
  await pane.module?.();
  flushSync(() => react.render(<BrainUiProvider root={ui}><SettingsPanel open onClose={() => {}} /></BrainUiProvider>));
  const panel = () => page.getByRole("tabpanel").element() as HTMLElement;
  await expect.poll(() => panel().textContent ?? "", { timeout: watchdogMs(5000) }).toContain(pane.ready);
  await expect.poll(() => pending, { timeout: watchdogMs(5000) }).toBe(0);
  await document.fonts.ready;
  await frame(); await frame();
  return { host, panel: panel() };
}

/** Width of `68ch` in the element's own font, measured by the browser. */
function measure(element: HTMLElement): number {
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;width:68ch;display:block";
  element.append(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return width;
}

/** Columns in a grid: distinct left edges of its items' first row. */
function columns(grid: HTMLElement): number {
  const items = [...grid.children].map(item => item.getBoundingClientRect()).filter(rect => rect.width > 0);
  const top = Math.min(...items.map(rect => rect.top));
  return items.filter(rect => Math.abs(rect.top - top) < 1).length;
}

function overflowing(panel: HTMLElement): string[] {
  const scrollers = [document.documentElement, panel, ...panel.querySelectorAll<HTMLElement>("*")]
    .filter(element => element === document.documentElement || element === panel || ["auto", "scroll"].includes(getComputedStyle(element).overflowY));
  return scrollers.filter(element => element.scrollWidth !== element.clientWidth).map(element => `${element.tagName.toLowerCase()}.${element.className} ${element.scrollWidth}/${element.clientWidth}`);
}

function assertLayout(pane: (typeof PANES)[number], panel: HTMLElement, width: number) {
  const container = panel.getBoundingClientRect().width;
  const cap = pane.wide ? 1200 : 720;
  expect.soft(container, `SETTINGS_PANE_CAP ${pane.name}`).toBeLessThanOrEqual(cap);
  if (width === 1440) {
    if (pane.wide) expect.soft(container, `SETTINGS_WIDE_PANE_GROWS ${pane.name}`).toBeGreaterThan(720);
    else expect.soft(container, `SETTINGS_STANDARD_PANE_KEEPS_720 ${pane.name}`).toBe(720);
  }
  const prose = [...panel.querySelectorAll<HTMLElement>("[data-prose]")];
  if (pane.wide && pane.tab !== "storage") expect.soft(prose.length, `SETTINGS_WIDE_PANE_HAS_PROSE ${pane.name}`).toBeGreaterThan(0);
  for (const block of prose) expect.soft(block.getBoundingClientRect().width, `SETTINGS_PROSE_MEASURE ${pane.name}: ${block.textContent?.slice(0, 40)}`).toBeLessThanOrEqual(measure(block) + 0.5);
  const grids = [...panel.querySelectorAll<HTMLElement>("[data-settings-grid]")];
  expect.soft(grids.length, `SETTINGS_PANE_GRIDS ${pane.name}`).toBe(pane.grids);
  for (const grid of grids) {
    const count = columns(grid);
    if (container < 560) expect.soft(count, `SETTINGS_GRID_STACKS ${pane.name} at ${container}`).toBe(1);
    else expect.soft(count, `SETTINGS_GRID_COLUMNS ${pane.name} at ${container}`).toBeGreaterThanOrEqual(container >= 840 ? 3 : 2);
  }
}

for (const width of [320, 900, 1280, 1440]) for (const theme of ["dark", "light"] as const) for (const pane of PANES) {
  test(`Settings ${pane.name} pane at ${width} ${theme} is ${pane.wide ? "wide" : "standard"}`, async ctx => {
    const { host, panel } = await mount(ctx, pane, width, 800, theme);
    assertLayout(pane, panel, width);
    if (width === 320) expect.soft(overflowing(panel), `SETTINGS_NO_HORIZONTAL_SCROLL ${pane.name}`).toEqual([]);
    await expect(page.elementLocator(host)).toMatchScreenshot(`settings-${pane.name}-${theme}-${width}`);
  });
}

// Browser zoom halves the layout viewport, media queries included: a 1280px
// window at 200% lays out as 640 CSS px and shows the compact strip.
for (const pane of PANES) test(`Settings ${pane.name} pane reflows at 200% zoom on 1280`, async ctx => {
  const { panel } = await mount(ctx, pane, 640, 400, "dark");
  expect(page.getByRole("tablist").element().getAttribute("aria-orientation")).toBe("horizontal");
  assertLayout(pane, panel, 640);
  expect(overflowing(panel), `SETTINGS_ZOOM_NO_HORIZONTAL_SCROLL ${pane.name}`).toEqual([]);
});
