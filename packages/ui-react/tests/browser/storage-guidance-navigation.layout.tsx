import { afterEach, expect, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { AppShell } from "../../src/components/layout/app-shell.js";
import { ActivityPage } from "../../src/components/activity/activity-page.js";
import { GraphPage } from "../../src/components/graph/graph-page.js";
import { useUIStore } from "../../src/stores/ui-store.js";
import { useHashRoutes } from "../../src/hooks/use-hash-routes.js";
import { storageGuidanceFixture, guidanceTime } from "../fixtures/storage-guidance.js";
let ui: BrainUiRoot, renderer: Root, host: HTMLElement, style: HTMLElement;
const original = { width: innerWidth, height: innerHeight, theme: document.documentElement.dataset.theme, hash: location.hash };
afterEach(async () => {
  if (renderer) flushSync(() => renderer.unmount()); ui?.dispose(); host?.remove(); style?.remove(); vi.useRealTimers();
  if (original.theme === undefined) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = original.theme;
  history.replaceState(null, "", `${location.pathname}${location.search}${original.hash}`); await page.viewport(original.width, original.height);
});
function Shell() { useHashRoutes(); const view = useUIStore(state => state.activeView); return <AppShell>{view === "activity" ? <ActivityPage /> : <GraphPage />}</AppShell>; }
for (const view of ["graph", "activity"] as const) for (const entry of ["indicator", "notification", "palette"] as const) for (const width of entry === "palette" ? [1280] : [320, 1280])
  test(`Storage ${entry} draws its pane from ${view} at ${width}`, async () => {
    await page.viewport(width, 900); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(guidanceTime);
    document.documentElement.dataset.theme = view === "graph" ? "dark" : "light";
    style = document.createElement("style"); style.textContent = await commands.formConsumerStyles(); document.head.append(style);
    host = document.createElement("div"); host.style.cssText = "position:fixed;inset:0"; document.body.append(host);
    history.replaceState(null, "", `#/${view}`); const fixture = storageGuidanceFixture(); ui = createBrainUiRoot({ storage: null, request: fixture.request });
    ui.stores.ui.getState().setActiveView(view); renderer = createRoot(host);
    flushSync(() => renderer.render(<BrainUiProvider root={ui}><Shell /></BrainUiProvider>));
    const indicator = page.getByRole("button", { name: "Open Storage: Very low space", exact: true }); await expect.poll(() => indicator.elements().length).toBe(1);
    if (entry === "indicator") { (indicator.element() as HTMLElement).focus(); await userEvent.keyboard("{Enter}"); }
    else if (entry === "notification") { history.replaceState(null, "", "#/settings/storage"); window.dispatchEvent(new HashChangeEvent("hashchange")); }
    else { await page.getByRole("button", { name: /^All commands/ }).click(); await page.getByRole("option", { name: /^Storage/ }).click(); }
    await expect.poll(() => host.querySelector("[data-storage-pane]"), { timeout: 5000, message: "STORAGE_FULL_SHELL_PANE_DRAWN" }).not.toBeNull();
    await expect.poll(() => host.querySelector("[data-storage-pane]")?.textContent).toContain("Pressure and growth");
    expect(host.querySelector("[data-storage-pane]")!.getBoundingClientRect().height).toBeGreaterThan(0);
    expect(ui.stores.ui.getState().activeView, "STORAGE_PRESERVES_HOSTING_VIEW").toBe(view);
    expect(ui.stores.ui.getState().settingsTab).toBe("storage");
    expect(fixture.inventory.requests.filter(row => row.method === "POST"), "STORAGE_NAVIGATION_HAS_NO_EFFECT").toHaveLength(0);
  });
