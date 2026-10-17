import { expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { BrainUiProvider, useRootStore } from "../../src/root-context.js";
import { createBrainUiRoot } from "../../src/root.js";
import { SettingsPanel } from "../../src/components/settings/settings-panel.js";

const panes = ["Appearance & input", "Models", "Accounts", "Skills", "Modules", "Security", "Devices & agents"];
for (const width of [320, 768, 1280]) for (const theme of ["dark", "light"] as const) {
  test(`Settings pane identity and manual traversal at ${width} ${theme}`, async ctx => {
    const before = { width: innerWidth, height: innerHeight, theme: document.documentElement.dataset.theme };
    const outer = await commands.formViewport(width, 800);
    await page.viewport(width, 800);
    document.documentElement.dataset.theme = theme;
    const style = document.createElement("style"); style.textContent = await commands.formConsumerStyles(); document.head.append(style);
    const host = document.createElement("div"); host.dataset.buttonGallery = ""; host.style.height = "800px"; document.body.append(host);
    const requests: string[] = [];
    const ui = createBrainUiRoot({ storage: null, request: async url => {
      requests.push(String(url));
      if (String(url).endsWith("/agent-policy")) return Response.json({ error: "Not configured" }, { status: 404 });
      return Response.json({ models: Array.from({ length: 24 }, (_, i) => ({ id: `ithaca-${i}`, label: `Ithaca model ${i + 1}`, hidden: false })), customModels: [], discovery: { enabled: false }, providers: [], configured: false, tools: [], principals: [], credentials: [], skills: [], enabled: [], available: [] });
    } });
    ui.stores.ui.setState({ theme });
    ui.stores.ui.getState().openSettings("models");
    const react = createRoot(host);
    ctx.onTestFinished(async () => {
      flushSync(() => react.unmount()); ui.dispose(); host.remove(); style.remove();
      if (before.theme === undefined) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = before.theme;
      await page.viewport(before.width, before.height); await commands.formViewport(outer.width - 100, outer.height - 120);
    });
    flushSync(() => react.render(<BrainUiProvider root={ui}><SettingsPanel open onClose={() => {}} /></BrainUiProvider>));
    await import("../../src/components/settings/models-tab.js");
    await expect.poll(() => requests.length).toBeGreaterThan(0);
    expect(page.getByRole("tab").elements().map(el => el.getAttribute("aria-label") ?? el.textContent), "SETTINGS_SEVEN_PANES").toEqual(panes);
    const models = page.getByRole("tab", { name: "Models", exact: true });
    expect(models.element().getAttribute("aria-selected")).toBe("true");
    expect(page.getByRole("radiogroup", { name: "Theme" }).elements()).toHaveLength(0);
    expect(page.getByRole("tabpanel").element().getAttribute("aria-labelledby")).toBe(models.element().id);
    await commands.buttonCapture(`settings-${width}-${theme}-models`);
    const scroller = page.getByRole("tabpanel").element().querySelector<HTMLElement>(".overflow-y-auto")!;
    scroller.scrollTop = scroller.scrollHeight;
    expect(scroller.scrollTop).toBeGreaterThan(0);
    flushSync(() => ui.stores.ui.getState().pressDestination("settings", { keyboard: true }));
    await expect.poll(() => scroller.scrollTop).toBe(0);
    expect(document.activeElement).toBe(models.element());
    expect(ui.stores.ui.getState().settingsTab).toBe("models");
    const count = requests.length;
    (models.element() as HTMLElement).focus();
    await userEvent.keyboard(width < 900 ? "{ArrowRight}" : "{ArrowDown}");
    expect(document.activeElement).toBe(page.getByRole("tab", { name: "Accounts", exact: true }).element());
    expect(ui.stores.ui.getState().settingsTab).toBe("models");
    expect(requests).toHaveLength(count);
    await userEvent.keyboard("{Home}{Enter}");
    await expect.poll(() => ui.stores.ui.getState().settingsTab).toBe("appearance");
    expect(page.getByRole("radiogroup", { name: "Theme" }).elements()).toHaveLength(1);
    expect(page.getByRole("tabpanel").element().textContent).toContain("Turning single-key shortcuts off");
    await commands.buttonCapture(`settings-${width}-${theme}-appearance`);
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(page.getByRole("tab", { name: "Devices & agents", exact: true }).element());
    expect(ui.stores.ui.getState().settingsTab).toBe("appearance");
    flushSync(() => ui.stores.principal.setState({ mintPending: true }));
    expect(page.getByRole("tab").elements().filter(el => (el as HTMLButtonElement).disabled)).toHaveLength(6);
    flushSync(() => ui.stores.principal.setState({ mintPending: false }));
    await page.getByRole("tab", { name: "Accounts", exact: true }).click();
    await import("../../src/components/settings/accounts-tab.js");
    await expect.poll(() => page.getByRole("tabpanel").element().textContent).toContain("No other provider accounts or web-search providers are configured on this server.");
    await commands.buttonCapture(`settings-${width}-${theme}-accounts`);
    for (const [name, module] of [["Skills", "skills-tab"], ["Modules", "modules-tab"], ["Security", "passkey-tab"], ["Devices & agents", "devices-agents-tab"]]) {
      await page.getByRole("tab", { name, exact: true }).click();
      // Explicit imports isolate cold transforms from the bounded DOM polls.
      if (module === "skills-tab") await import("../../src/components/settings/skills-tab.js");
      if (module === "modules-tab") await import("../../src/components/settings/modules-tab.js");
      if (module === "passkey-tab") await import("../../src/components/settings/passkey-tab.js");
      if (module === "devices-agents-tab") await import("../../src/components/settings/devices-agents-tab.js");
      await expect.poll(() => page.getByRole("tabpanel").element().textContent!.length).toBeGreaterThan(0);
      expect(page.getByRole("radiogroup", { name: "Theme" }).elements()).toHaveLength(0);
      const button = page.getByRole("tab", { name, exact: true }).element();
      const b = button.getBoundingClientRect();
      expect(b.height).toBeGreaterThanOrEqual(44);
      if (width < 900) {
        const strip = button.closest('[role="tablist"]')!.getBoundingClientRect();
        expect(b.left).toBeGreaterThanOrEqual(strip.left);
        expect(b.right).toBeLessThanOrEqual(strip.right - 23);
      }
      await commands.buttonCapture(`settings-${width}-${theme}-${module}`);
    }
    if (width === 1280) {
      for (const name of ["Accounts", "Appearance & input"]) {
        await page.getByRole("tab", { name, exact: true }).click();
        await page.viewport(320, 800);
        await expect.poll(() => page.getByRole("tablist").element().getAttribute("aria-orientation")).toBe("horizontal");
        const button = page.getByRole("tab", { name, exact: true }).element();
        expect(button.getAttribute("aria-selected")).toBe("true");
        const b = button.getBoundingClientRect(); const strip = button.closest('[role="tablist"]')!.getBoundingClientRect();
        expect(b.left).toBeGreaterThanOrEqual(strip.left);
        expect(b.right).toBeLessThanOrEqual(strip.right - 23);
        await page.viewport(1280, 800);
        await expect.poll(() => page.getByRole("tablist").element().getAttribute("aria-orientation")).toBe("vertical");
        expect(page.getByRole("tab", { name, exact: true }).element().getAttribute("aria-selected")).toBe("true");
      }
    }
  });
}

test("moved Accounts flows, Security revocation and device preferences retain their requests", async ctx => {
  const outer = await commands.formViewport(320, 800);
  const before = { width: innerWidth, height: innerHeight };
  await page.viewport(320, 800);
  const style = document.createElement("style"); style.textContent = await commands.formConsumerStyles(); document.head.append(style);
  const host = document.createElement("div"); host.dataset.buttonGallery = ""; host.style.height = "800px"; document.body.append(host);
  let connected = false; let accounts = true; let search = true; let granted = true; let keyConfigured = false; let searchEnabled = false;
  const writes: string[] = [];
  const request = async (url: string, init?: RequestInit) => {
    const path = new URL(url, "http://fixture.invalid").pathname;
    if (init?.method && init.method !== "GET") writes.push(`${init.method} ${path}`);
    if (path === "/api/pi-auth/providers") return Response.json({ providers: accounts ? [{ providerId: "ithaca", name: "Ithaca provider", configured: connected, source: connected ? "stored" : undefined, oauth: true }] : [] });
    if (path === "/api/pi-auth/login" && init?.method === "POST") return Response.json({ flow: { id: "voyage", providerId: "ithaca", status: "pending", userCode: "ITHACA-CODE", startedAt: Date.UTC(2026, 6, 12), intervalSeconds: 1 } });
    if (path === "/api/pi-auth/login/voyage" && init?.method === "DELETE") return Response.json({ ok: true });
    if (path === "/api/pi-auth/login/voyage") { connected = true; return Response.json({ flow: { id: "voyage", providerId: "ithaca", status: "success", startedAt: Date.UTC(2026, 6, 12) } }); }
    if (path === "/api/pi-auth/logout") { connected = false; return Response.json({ ok: true }); }
    if (path === "/api/web-search" && init?.method === "PUT") {
      const update = JSON.parse(String(init.body));
      if (update.apiKeys) keyConfigured = Boolean(update.apiKeys.voyage);
      if (update.enabled) searchEnabled = update.enabled.voyage;
    }
    if (path === "/api/web-search") return Response.json({ configured: search, order: [], overriddenBy: null, appliesTo: [], providers: [{ id: "voyage", label: "Voyage search", enabled: searchEnabled, hasKeyField: true, keyConfigured, keyFromEnv: false, keyless: false, costNote: "Paid", blurb: "Find sailing notes" }] });
    if (path === "/api/tool-permissions/web_search" && init?.method === "DELETE") { granted = false; return Response.json({ tools: [] }); }
    if (path === "/api/tool-permissions") return Response.json({ tools: granted ? ["web_search"] : [] });
    if (path === "/api/auth/passkey/list") return Response.json({ credentials: [] });
    return Response.json({ providers: [], models: [] });
  };
  const data = new Map<string, string>();
  const storage: Storage = { get length() { return data.size; }, key: i => [...data.keys()][i] ?? null, clear: () => data.clear(), getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: k => { data.delete(k); } };
  const ui = createBrainUiRoot({ storage, storagePrefix: "odysseus-settings-test", answerStorage: null, answerTabs: null, request });
  const react = createRoot(host);
  ctx.onTestFinished(async () => { flushSync(() => react.unmount()); ui.dispose(); host.remove(); style.remove(); await page.viewport(before.width, before.height); await commands.formViewport(outer.width - 100, outer.height - 120); });
  const render = () => flushSync(() => react.render(<BrainUiProvider root={ui}><SettingsPanel open onClose={() => {}} /></BrainUiProvider>));
  ui.stores.ui.getState().openSettings("accounts"); render();
  await import("../../src/components/settings/accounts-tab.js");
  await expect.poll(() => page.getByRole("button", { name: "Connect", exact: true }).elements().length).toBe(1);
  expect(page.getByRole("tabpanel").element().textContent).toContain("Voyage search");
  await page.getByRole("button", { name: "Needs key", exact: true }).click();
  await page.getByRole("textbox", { name: "API key", exact: true }).fill("odysseus-fictional-key");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => keyConfigured).toBe(true);
  await page.getByRole("switch", { name: "Enable Voyage search for web search", exact: true }).click();
  await expect.poll(() => searchEnabled).toBe(true);
  expect(writes.filter(write => write === "PUT /api/web-search")).toHaveLength(2);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect.poll(() => page.getByRole("tabpanel").element().textContent).toContain("ITHACA-CODE");
  await commands.buttonCapture("settings-accounts-device-code");
  await expect.poll(() => page.getByRole("button", { name: "Disconnect", exact: true }).elements().length, { timeout: 3000 }).toBe(1);
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect.poll(() => connected).toBe(false);
  expect(writes).toContain("POST /api/pi-auth/login"); expect(writes).toContain("POST /api/pi-auth/logout");
  await page.getByRole("tab", { name: "Security", exact: true }).click();
  await import("../../src/components/settings/passkey-tab.js");
  await expect.poll(() => page.getByRole("tabpanel").element().textContent).toContain("web_search");
  expect(page.getByRole("button", { name: "Sign out everywhere", exact: true }).elements()).toHaveLength(1);
  await commands.buttonCapture("settings-security-grant");
  await page.getByRole("button", { name: /web_search/ }).click();
  await expect.poll(() => granted).toBe(false);
  await expect.poll(() => page.getByRole("tabpanel").element().textContent).not.toContain("web_search");
  expect(writes).toContain("DELETE /api/tool-permissions/web_search");
  // Both partial-section states stay useful, without the combined empty copy.
  for (const state of [[false, true], [true, false]]) {
    [accounts, search] = state;
    await page.getByRole("tab", { name: "Accounts", exact: true }).click();
    await expect.poll(() => page.getByRole("tabpanel").element().textContent).toContain(accounts ? "Ithaca provider" : "Voyage search");
    expect(page.getByRole("tabpanel").element().textContent).not.toContain("No other provider accounts");
    await page.getByRole("tab", { name: "Appearance & input", exact: true }).click();
  }
  await page.getByRole("radio", { name: "Paper", exact: true }).click();
  await page.getByRole("switch", { name: "Single-key shortcuts", exact: true }).click();
  const reloaded = createBrainUiRoot({ storage, storagePrefix: "odysseus-settings-test", answerStorage: null, answerTabs: null, request });
  expect(reloaded.stores.ui.getState().theme).toBe("light");
  expect(reloaded.stores.ui.getState().singleKeyShortcuts).toBe(false);
  reloaded.dispose();
});


for (const width of [320, 1280]) test(`closing Settings returns to its opener at ${width}`, async ctx => {
  const outer = await commands.formViewport(width, 800);
  const before = { width: innerWidth, height: innerHeight };
  await page.viewport(width, 800);
  const style = document.createElement("style"); style.textContent = await commands.formConsumerStyles(); document.head.append(style);
  const host = document.createElement("div"); document.body.append(host);
  const ui = createBrainUiRoot({ storage: null, request: async () => Response.json({ models: [], customModels: [], discovery: { enabled: false } }) });
  const react = createRoot(host);
  function Shell() {
    const open = useRootStore("ui", state => state.settingsPanelOpen);
    return <><button onClick={() => ui.stores.ui.getState().openSettings("models")}>Open Settings</button><button onClick={() => ui.stores.ui.getState().setActiveView("activity")}>Actions</button><SettingsPanel open={open} onClose={() => ui.stores.ui.getState().setSettingsPanelOpen(false)} /></>;
  }
  ctx.onTestFinished(async () => { flushSync(() => react.unmount()); ui.dispose(); host.remove(); style.remove(); await page.viewport(before.width, before.height); await commands.formViewport(outer.width - 100, outer.height - 120); });
  flushSync(() => react.render(<BrainUiProvider root={ui}><Shell /></BrainUiProvider>));
  const opener = page.getByRole("button", { name: "Open Settings", exact: true });
  await opener.click();
  await expect.poll(() => page.getByRole("tab", { name: "Models", exact: true }).elements().length).toBe(1);
  await page.getByRole("button", { name: width < 900 ? "Close Settings" : "Close", exact: true }).click();
  await expect.poll(() => document.activeElement === opener.element(), { message: "SETTINGS_RETURNS_OPENER_FOCUS" }).toBe(true);
  await opener.click();
  await expect.poll(() => page.getByRole("tab", { name: "Models", exact: true }).elements().length).toBe(1);
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.activeElement === opener.element(), { message: "SETTINGS_ESCAPE_RETURNS_OPENER_FOCUS" }).toBe(true);
  await opener.click();
  await page.getByRole("tab", { name: "Models", exact: true }).click();
  const resized = width === 320 ? 1280 : 320;
  await commands.formViewport(resized, 800); await page.viewport(resized, 800);
  await expect.poll(() => page.getByRole("tablist").element().getAttribute("aria-orientation")).toBe(resized < 900 ? "horizontal" : "vertical");
  await page.getByRole("button", { name: resized < 900 ? "Close Settings" : "Close", exact: true }).click();
  await expect.poll(() => document.activeElement === opener.element(), { message: "SETTINGS_RESIZE_RETURNS_ORIGINAL_OPENER" }).toBe(true);
  if (width === 1280) {
    await commands.formViewport(1280, 800); await page.viewport(1280, 800);
    await opener.click();
    const actions = page.getByRole("button", { name: "Actions", exact: true });
    await actions.click();
    await expect.poll(() => ui.stores.ui.getState().settingsPanelOpen).toBe(false);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    expect(document.activeElement === actions.element(), "SETTINGS_CLOSE_PRESERVES_NEW_DESTINATION_FOCUS").toBe(true);
  }
});
