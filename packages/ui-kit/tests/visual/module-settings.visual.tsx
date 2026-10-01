import { expect, test } from "vitest";
import { commands, page } from "vitest/browser";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ModuleSettingsSnapshot } from "@schlessera/brain-ui-sdk";
import { createBrainUiRoot } from "../../../ui-react/src/root.js";
import { BrainUiProvider, useRootStore } from "../../../ui-react/src/root-context.js";
import { SettingsPanel } from "../../../ui-react/src/components/settings/settings-panel.js";
import snapshotFixture from "./fixtures/module-settings.json";
import catalogFixture from "./fixtures/module-settings-catalog.json";
import { SettingsFields } from "../../../ui-react/src/components/settings/module-settings-fields.js";
import { createModuleSettingsSession, savedDraft } from "../../../ui-react/src/components/settings/module-settings-state.js";
import { useStore } from "zustand";

function Shell() {
  const open = useRootStore("ui", (s) => s.settingsPanelOpen);
  const close = useRootStore("ui", (s) => s.setSettingsPanelOpen);
  return <SettingsPanel open={open} onClose={() => close(false)} />;
}
function button(doc: Document, label: string): HTMLElement {
  const found = [...doc.querySelectorAll<HTMLElement>('button,[role="button"],[role="switch"]')].find((element) => element.textContent?.trim() === label || element.getAttribute("aria-label") === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
function enter(doc: Document, id: string, value: string) {
  const input = doc.getElementById(id) as HTMLInputElement;
  expect(input).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(doc.defaultView!.HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => { setter.call(input, value); input.dispatchEvent(new doc.defaultView!.Event("input", { bubbles: true })); });
}

test("generic module fields render every leaf kind, discover new schema fields and retain complete unsupported values", async () => {
  await page.viewport(320, 800); await commands.formViewport(320, 800);
  const host = document.createElement("div"); host.style.width = "320px"; document.body.append(host);
  const style = document.createElement("style"); style.textContent = await commands.formConsumerStyles(); document.head.append(style);
  const snapshot = catalogFixture as ModuleSettingsSnapshot;
  const store = createModuleSettingsSession(); store.setState({ snapshot, draft: snapshot.overrides });
  function Fixture() { const session = useStore(store); return <SettingsFields snapshot={snapshot} session={session} store={store} />; }
  const react = createRoot(host);
  try {
    flushSync(() => react.render(<Fixture />));
    expect([...host.querySelectorAll('[data-setting-path]')].map((field) => field.getAttribute('data-setting-path')).sort()).toEqual(['title','count','toggle','mode','choices','tags','weights','nested','nested.note','items','items.0.name','items.0.count','items.1.name','items.1.count','addedLater','unsupported'].sort());
    expect((document.getElementById("module-setting-addedLater") as HTMLInputElement).value).toBe("Found from schema");
    expect(host.textContent).toContain("Keeps everything");
    expect(host.textContent).toContain("Edited outside Settings");
    expect(host.querySelector('[role="radiogroup"][aria-label="Travel"]')).not.toBeNull();
    const navigator = host.querySelector('input[type="checkbox"]') as HTMLInputElement;
    flushSync(() => navigator.click());
    flushSync(() => button(document, "Signal").click());
    enter(document, "module-setting-title", "Return to Ithaca");
    enter(document, "module-setting-count", "7");
    enter(document, "module-setting-addedLater", "Edited without metadata");
    flushSync(() => button(document, "Move Crew down").click());
    flushSync(() => button(document, "Add Items item").click());
    const draft = savedDraft(store.getState());
    expect(draft).toMatchObject({ title: "Return to Ithaca", count: 7, toggle: true, choices: ["navigator"], addedLater: "Edited without metadata", unsupported: snapshot.overrides.unsupported });
    expect(draft.items).toEqual([{ name: "Fleet", count: 2 }, { name: "Crew", count: 3 }, { name: "", count: 1 }]);
    expect(host.scrollWidth, [...host.querySelectorAll<HTMLElement>("*")].filter((el) => el.getBoundingClientRect().right > host.getBoundingClientRect().right + 1).map((el) => `${el.tagName} ${el.getAttribute("aria-label") ?? el.className}`).join("\n")).toBeLessThanOrEqual(320);
  } finally { flushSync(() => react.unmount()); host.remove(); style.remove(); }
});

for (const theme of ["dark", "light"]) for (const width of [320, 1440]) {
  test(`module settings: source-preserving edits and guarded navigation in ${theme} at ${width}px`, async () => {
    await page.viewport(width, 800);
    await commands.formViewport(width, 800);
    const iframe = document.createElement("iframe");
    iframe.dataset.moduleSettings = "";
    iframe.style.cssText = `width:${width}px;height:800px;border:0`;
    document.body.append(iframe);
    const doc = iframe.contentDocument!;
    doc.documentElement.dataset.theme = theme;
    doc.body.style.cssText = "margin:0";
    const style = doc.createElement("style");
    style.textContent = await commands.formConsumerStyles();
    doc.head.append(style);
    const host = doc.createElement("div"); doc.body.append(host);
    let snapshot = structuredClone(snapshotFixture) as ModuleSettingsSnapshot & { values: Record<string, unknown>; inherited: Record<string, unknown> };
    const saves: Array<{ values: Record<string, unknown>; revision: string | null }> = [];
    let reject: "validation" | "conflict" | "network" | null = null;
    const ui = createBrainUiRoot({ storage: null, request: async (url, init) => {
      const path = new URL(url, "http://fixture.example").pathname;
      if (path.endsWith("/modules")) return Response.json({ enabled: [{ name: "jobs", key: snapshot.key, state: "active", settings: true, description: "Find the next voyage" }, { name: "broken", key: "./broken", state: "unavailable", settings: false, error: "Repair the module config" }], available: [] });
      if (path.endsWith("/settings/preview")) return Response.json({ ...snapshot, notes: [{ key: "scoring.groups", text: "Highest possible score 25" }] });
      if (init?.method === "PUT") {
        const values = JSON.parse(String(init.body)).values;
        if (reject === "network") throw new Error("Connection interrupted. Retry Save.");
        if (reject === "validation") return Response.json({ error: "Review the highlighted settings", errors: [{ path: "scoring.groups.0.name", message: "Name is required" }] }, { status: 422 });
        if (reject === "conflict") { snapshot = { ...snapshot, overrides: { ...snapshot.overrides, queries: ["saved elsewhere"] }, revision: '"fixture-remote"' }; return Response.json({ error: "Changed elsewhere" }, { status: 409 }); }
        saves.push({ values, revision: new Headers(init.headers).get("If-Match") });
        snapshot = { ...snapshot, overrides: values, revision: '"fixture-next"', changed: true, commit: "abcdef0123456789" };
      }
      return Response.json(snapshot);
    } });
    const react = createRoot(host);
    try {
      ui.stores.ui.getState().openSettings("modules");
      flushSync(() => react.render(<BrainUiProvider root={ui}><Shell /></BrainUiProvider>));
      await expect.poll(() => doc.body.textContent).toContain("Configure Jobs");
      expect(button(doc, "View Broken").getAttribute("aria-disabled")).not.toBe("true");
      flushSync(() => button(doc, "View Broken").click());
      await expect.poll(() => doc.body.textContent).toContain("This detail is read-only");
      expect(doc.body.textContent).toContain("Repair the module config");
      expect(doc.querySelector('[data-setting-path]')).toBeNull();
      flushSync(() => button(doc, "Back to modules").click());
      await commands.moduleSettingsScreenshot(`${width === 320 ? "mobile" : "desktop"}-${theme}-list`);
      flushSync(() => button(doc, "Configure Jobs").click());
      await expect.poll(() => doc.getElementById("module-setting-scoring.groups.0.name")).not.toBeNull();
      expect((doc.getElementById("module-setting-scoring.compensationBenchmark") as HTMLInputElement).value).toBe("120000.00");
      expect(doc.querySelector('input[aria-label="USD weight"]')).not.toBeNull();
      expect(doc.querySelector('input[aria-label="Add Queries"]')).not.toBeNull();
      expect(doc.body.textContent).toContain("saved but not run");
      expect(doc.body.textContent).toContain("set in brain config");
      expect(button(doc, "Score location").getAttribute("aria-checked")).toBe("false");
      expect(doc.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      const name = doc.getElementById("module-setting-scoring.groups.0.name")!;
      expect(name.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      await new Promise((resolve) => setTimeout(resolve, 350));
      await commands.moduleSettingsScreenshot(width === 320 ? `mobile-${theme}` : `desktop-${theme}`);
      const editor = doc.querySelector<HTMLElement>("[data-module-settings-editor]")!;
      for (const [section, path] of [["tiers", "scoring.groups.0.tiers"], ["sources", "boards"], ["storage", "opportunitiesDir"]]) {
        const field = doc.querySelector<HTMLElement>(`[data-setting-path="${path}"]`)!;
        editor.scrollTop += field.getBoundingClientRect().top - editor.getBoundingClientRect().top;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        expect(editor.scrollTop).toBeGreaterThan(0);
        await commands.moduleSettingsScreenshot(`${width === 320 ? "mobile" : "desktop"}-${theme}-${section}`);
      }
      editor.scrollTop = 0;

      // Switching style twice must retain both source forms and their casing.
      flushSync(() => button(doc, "One keyword list").click());
      expect(doc.body.textContent).toContain("tiers will be removed");
      flushSync(() => button(doc, "Graded tiers").click());
      expect(doc.body.textContent).not.toContain("Unsaved changes");
      enter(doc, "module-setting-scoring.groups.0.name", "Fleet navigation");
      expect(doc.body.textContent).toContain("Unsaved changes");
      await commands.moduleSettingsScreenshot(`${width === 320 ? "mobile" : "desktop"}-${theme}-dirty`);
      expect(ui.stores.ui.getState().settingsNavigationProtected).toBe(true);
      flushSync(() => ui.stores.ui.getState().closeAllPanels());
      expect(ui.stores.ui.getState().settingsPanelOpen).toBe(true);
      expect(doc.body.textContent).toContain("Keep your unsaved changes?");
      flushSync(() => button(doc, "Keep editing").click());
      editor.scrollTop = editor.scrollHeight;
      reject = "network";
      flushSync(() => button(doc, "Save").click());
      await expect.poll(() => doc.body.textContent).toContain("Connection interrupted");
      expect(doc.querySelector("[data-module-settings-lifecycle]")?.textContent).toContain("Connection interrupted");
      expect((name as HTMLInputElement).value).toBe("Fleet navigation");
      reject = "validation";
      flushSync(() => button(doc, "Save").click());
      await expect.poll(() => doc.body.textContent).toContain("Name is required");
      expect(name.getAttribute("aria-invalid")).toBe("true");
      await expect.poll(() => doc.activeElement?.id).toBe("module-setting-scoring.groups.0.name");
      const lifecycleTop = doc.querySelector("[data-module-settings-lifecycle]")!.getBoundingClientRect().top;
      expect(name.getBoundingClientRect().bottom).toBeLessThan(lifecycleTop);
      expect(doc.getElementById("module-setting-scoring.groups.0.name-error")!.getBoundingClientRect().bottom).toBeLessThan(lifecycleTop);
      await commands.moduleSettingsScreenshot(`${width === 320 ? "mobile" : "desktop"}-${theme}-validation`);
      enter(doc, "module-setting-scoring.groups.0.name", "Fleet navigation revised");
      reject = null;
      flushSync(() => button(doc, "Save").click());
      await expect.poll(() => saves.length).toBe(1);
      const scoring = saves[0]!.values.scoring as { groups: Array<Record<string, unknown>>; compensationBenchmark: unknown; location?: unknown; queueThreshold?: unknown };
      expect(scoring.groups[0]).toMatchObject({ name: "Fleet navigation revised", keywords: ["LegacyCase"], tiers: [{ points: 25, keywords: ["Navigation", "Harbor"] }, { points: 15, keywords: ["Sailing"] }] });
      expect(scoring.compensationBenchmark).toBe("12000000");
      expect(scoring.location).toBeUndefined();
      expect(scoring.queueThreshold).toBeUndefined();
      expect(saves[0]!.revision).toBe('"fixture-original"');
      await expect.poll(() => ui.stores.ui.getState().settingsNavigationProtected).toBe(false);
      expect(doc.body.textContent).toContain("commit abcdef0");
      expect(doc.querySelector("[data-module-settings-lifecycle]")?.textContent).toContain("commit abcdef0");
      expect(doc.documentElement.scrollWidth).toBeLessThanOrEqual(width);

      enter(doc, "module-setting-queries", "Unsaved query in progress");
      expect(ui.stores.ui.getState().settingsNavigationProtected).toBe(true);
      flushSync(() => ui.stores.ui.getState().setSettingsTab("models"));
      expect(ui.stores.ui.getState().settingsTab).toBe("modules");
      expect(doc.body.textContent).toContain("Keep your unsaved changes?");
      flushSync(() => button(doc, "Keep editing").click());
      flushSync(() => button(doc, "Discard").click());
      expect((doc.getElementById("module-setting-queries") as HTMLInputElement).value).toBe("");

      // A resize remounts the pane/drawer body; the draft and its guard survive.
      enter(doc, "module-setting-scoring.groups.0.name", "Across the breakpoint");
      const resized = width === 320 ? 1440 : 320;
      iframe.style.width = `${resized}px`;
      await page.viewport(resized, 800); await commands.formViewport(resized, 800);
      await expect.poll(() => (doc.getElementById("module-setting-scoring.groups.0.name") as HTMLInputElement | null)?.value).toBe("Across the breakpoint");
      expect(ui.stores.ui.getState().settingsNavigationProtected).toBe(true);
      reject = "conflict";
      flushSync(() => button(doc, "Save").click());
      await expect.poll(() => doc.querySelector('[aria-label="Review conflicting settings"]')).not.toBeNull();
      expect(doc.querySelector("[data-module-settings-lifecycle]")?.textContent).toContain("Settings changed elsewhere");
      flushSync(() => button(doc, "Review").click());
      expect(doc.activeElement?.getAttribute("aria-label")).toBe("Review conflicting settings");
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await commands.moduleSettingsScreenshot(`${resized === 320 ? "mobile" : "desktop"}-${theme}-conflict`);
      const reviewed = button(doc, "Save reviewed settings");
      expect(reviewed.getAttribute("aria-disabled")).toBe("true");
      const radios = [...doc.querySelectorAll<HTMLInputElement>('input[type="radio"][name^="conflict-"]')].filter((input) => input.parentElement?.textContent?.includes("Use yours"));
      expect(radios.length).toBeGreaterThan(0);
      for (const radio of radios) flushSync(() => radio.click());
      reject = null;
      flushSync(() => reviewed.click());
      await expect.poll(() => saves.length).toBe(2);
      expect(saves[1]!.revision).toBe('"fixture-remote"');
      expect((saves[1]!.values.scoring as { groups: Array<{ name: string }> }).groups[0]!.name).toBe("Across the breakpoint");
    } finally {
      flushSync(() => react.unmount()); ui.dispose(); iframe.remove();
    }
  });
}


test("jobs nested drafts preserve tiers through reorder, reject extra currency decimals and keep optional values absent", async () => {
  await page.viewport(320, 800); await commands.formViewport(320, 800);
  const host = document.createElement("div"); host.style.width = "320px"; document.body.append(host);
  const style = document.createElement("style"); style.textContent = await commands.formConsumerStyles(); document.head.append(style);
  const snapshot = structuredClone(snapshotFixture) as ModuleSettingsSnapshot;
  const store = createModuleSettingsSession(); store.setState({ snapshot, draft: snapshot.overrides });
  function Fixture() { const session = useStore(store); return <SettingsFields snapshot={snapshot} session={session} store={store} />; }
  const react = createRoot(host);
  try {
    flushSync(() => react.render(<Fixture />));
    const original = savedDraft(store.getState());
    enter(document, "module-setting-scoring.groups.0.tiers.0.points", "24");
    const expected = structuredClone(original);
    (((expected.scoring as { groups: Array<Record<string, unknown>> }).groups[0]!.tiers) as Array<{ points: number }>)[0]!.points = 24;
    expect(savedDraft(store.getState())).toEqual(expected);
    // An invalid amount remains editable; correcting it stores whole EUR cents.
    enter(document, "module-setting-scoring.compensationBenchmark", "120000.001");
    expect(host.textContent).toContain("Use at most 2 decimals");
    expect((document.getElementById("module-setting-scoring.compensationBenchmark") as HTMLInputElement).value).toBe("120000.001");
    enter(document, "module-setting-scoring.compensationBenchmark", "120000.01");
    expect(host.textContent).not.toContain("Use at most 2 decimals");
    expect((savedDraft(store.getState()).scoring as { groups: Array<Record<string, unknown>>; compensationBenchmark?: unknown; location?: unknown }).compensationBenchmark).toBe(12000001);
    flushSync(() => button(document, "Score location").click());
    expect((savedDraft(store.getState()).scoring as { groups: Array<Record<string, unknown>>; compensationBenchmark?: unknown; location?: unknown }).location).toBeDefined();
    flushSync(() => button(document, "Score location").click());
    expect((savedDraft(store.getState()).scoring as { groups: Array<Record<string, unknown>>; compensationBenchmark?: unknown; location?: unknown }).location).toBeUndefined();
    flushSync(() => button(document, "One keyword list").click());
    enter(document, "module-setting-scoring.groups.0.keywords", "Pending case");
    flushSync(() => button(document, "Add group").click());
    flushSync(() => button(document, "Move Navigation down").click());
    expect((savedDraft(store.getState()).scoring as { groups: Array<Record<string, unknown>>; compensationBenchmark?: unknown; location?: unknown }).groups[1]).toMatchObject({ keywords: ["LegacyCase"] });
    expect((savedDraft(store.getState()).scoring as { groups: Array<Record<string, unknown>>; compensationBenchmark?: unknown; location?: unknown }).groups[1].tiers).toBeUndefined();
    expect(store.getState().pendingInputs["scoring.groups.1.keywords"]).toBe("Pending case");
    flushSync(() => button(document, "Remove Navigation").click());
    expect(host.textContent).toContain("Remove Navigation?");
    flushSync(() => button(document, "Keep").click());
    expect((savedDraft(store.getState()).scoring as { groups: Array<Record<string, unknown>>; compensationBenchmark?: unknown; location?: unknown }).groups).toHaveLength(2);
    flushSync(() => button(document, "Remove Navigation").click());
    const removal = button(document, "Remove");
    expect(removal.getAttribute("aria-disabled")).not.toBe("true");
    flushSync(() => removal.click());
    expect((savedDraft(store.getState()).scoring as { groups: Array<Record<string, unknown>>; compensationBenchmark?: unknown; location?: unknown }).groups).toHaveLength(1);
    expect(Object.keys(store.getState().pendingInputs)).not.toContain("scoring.groups.1.keywords");
    expect(Object.keys(store.getState().variants)).not.toContain("scoring.groups.1");
  } finally { flushSync(() => react.unmount()); host.remove(); style.remove(); }
});

test("modules show loading, retry and empty states, and separate migration, dormancy and declared actions", async () => {
  await page.viewport(320, 800); await commands.formViewport(320, 800);
  const iframe = document.createElement("iframe"); iframe.dataset.moduleSettings = "";
  iframe.style.cssText = "width:320px;height:800px;border:0"; document.body.append(iframe);
  const doc = iframe.contentDocument!; doc.documentElement.dataset.theme = "dark"; doc.body.style.margin = "0";
  const host = doc.createElement("div"); doc.body.append(host);
  const style = doc.createElement("style"); style.textContent = await commands.formConsumerStyles(); doc.head.append(style);
  const scoring = structuredClone(snapshotFixture.overrides.scoring);
  let snapshot = structuredClone(snapshotFixture) as ModuleSettingsSnapshot & { values: Record<string, unknown>; inherited: Record<string, unknown> };
  delete snapshot.overrides.scoring; delete snapshot.values.scoring; delete snapshot.inherited.scoring;
  let list: "waiting" | "error" | "empty" | "ready" = "waiting";
  let releaseList!: () => void;
  const waiting = new Promise<void>((resolve) => { releaseList = resolve; });
  let holdAction = false; let releaseAction!: () => void;
  const actionWait = new Promise<void>((resolve) => { releaseAction = resolve; });
  const operations: Array<{ path: string; revision: string | null }> = [];
  const ui = createBrainUiRoot({ storage: null, request: async (url, init) => {
    const path = new URL(url, "http://fixture.example").pathname;
    if (path.endsWith("/modules")) {
      if (list === "waiting") { await waiting; return Response.json({ error: "Try the connection again" }, { status: 500 }); }
      if (list === "error") return Response.json({ error: "Try the connection again" }, { status: 500 });
      return Response.json({ enabled: list === "empty" ? [] : [{ name: "jobs", key: snapshot.key, settings: true, state: snapshot.state }], available: [] });
    }
    if (path.endsWith("/migration/preview")) return Response.json({ module: "jobs", revision: '"migration-preview"', source: "career/criteria.md", original: scoring, values: { scoring }, moved: scoring, summary: "1 group and 2 tiers carried over; parsed rules are identical.", parserEquivalent: true, warnings: ["Unknown scoring keys stay in the criteria document."] });
    if (init?.method === "POST") {
      operations.push({ path, revision: new Headers(init.headers).get("If-Match") });
      if (path.endsWith("/migration")) { snapshot = { ...snapshot, values: { ...snapshot.values, scoring }, overrides: { ...snapshot.overrides, scoring }, revision: '"migrated"', changed: true, commit: "abcdef01" }; return Response.json(snapshot); }
      if (path.endsWith("/state")) { const state = JSON.parse(String(init.body)).state; snapshot = { ...snapshot, state, revision: '"after-state"' }; return Response.json({ module: "jobs", state, context: { left: ["jobs-search"], entered: [] } }); }
      if (path.includes("/actions/")) { if (holdAction) await actionWait; return Response.json({ updated: 3 }); }
    }
    return Response.json(snapshot);
  } });
  const react = createRoot(host);
  try {
    ui.stores.ui.getState().openSettings("modules");
    flushSync(() => react.render(<BrainUiProvider root={ui}><Shell /></BrainUiProvider>));
    await expect.poll(() => host.querySelector('[aria-label="Loading modules"]')).not.toBeNull();
    await commands.moduleSettingsScreenshot("mobile-dark-loading");
    releaseList();
    await expect.poll(() => host.textContent).toContain("Try the connection again");
    list = "empty"; flushSync(() => button(doc, "Retry").click());
    await expect.poll(() => host.textContent).toContain("No modules are configured");
    await commands.moduleSettingsScreenshot("mobile-dark-empty");
    list = "ready";
    flushSync(() => ui.stores.ui.getState().setSettingsPanelOpen(false));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    flushSync(() => ui.stores.ui.getState().setSettingsPanelOpen(true));
    await expect.poll(() => host.textContent).toContain("Configure Jobs");
    flushSync(() => button(doc, "Configure Jobs").click());
    await expect.poll(() => host.textContent).toContain("Preview migration");
    flushSync(() => button(doc, "Preview migration").click());
    await expect.poll(() => host.querySelector('[aria-label="Migration preview"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Migration preview"]')?.textContent).toContain("Navigation");
    expect(host.textContent).toContain("1 group and 2 tiers carried over");
    const readonlyName = doc.getElementById("module-setting-scoring.groups.0.name") as HTMLInputElement;
    expect(readonlyName.disabled).toBe(true);
    await commands.moduleSettingsScreenshot("mobile-dark-migration");
    flushSync(() => button(doc, "Move scoring rules").click());
    await expect.poll(() => host.textContent).toContain("commit abcdef0");
    expect(operations).toEqual([{ path: "/api/modules/jobs/migration", revision: '"migration-preview"' }]);
    enter(doc, "module-setting-scoring.groups.0.name", "Unsaved voyage");
    expect(button(doc, "Make dormant").getAttribute("aria-disabled")).toBe("true");
    expect(button(doc, "Rescore now").getAttribute("aria-disabled")).toBe("true");
    flushSync(() => button(doc, "Discard").click());
    flushSync(() => button(doc, "Make dormant").click());
    expect(host.textContent).toContain("Make Jobs dormant?");
    const editor = doc.querySelector<HTMLElement>("[data-module-settings-editor]")!;
    editor.scrollTop = editor.scrollHeight;
    await commands.moduleSettingsScreenshot("mobile-dark-state-confirmation");
    flushSync(() => button(doc, "Confirm").click());
    await expect.poll(() => host.textContent).toContain("Jobs is dormant");
    expect(button(doc, "Rescore now").getAttribute("aria-disabled")).toBe("true");
    expect((doc.getElementById("module-setting-scoring.groups.0.name") as HTMLInputElement).value).toBe("Navigation");
    flushSync(() => button(doc, "Activate module").click()); flushSync(() => button(doc, "Confirm").click());
    await expect.poll(() => host.textContent).toContain("Jobs is active");
    holdAction = true;
    flushSync(() => button(doc, "Rescore now").click());
    expect(host.textContent).toContain("Rescore all jobs");
    flushSync(() => button(doc, "Confirm").click());
    await expect.poll(() => ui.stores.ui.getState().settingsNavigationProtected).toBe(true);
    flushSync(() => ui.stores.ui.getState().closeAllPanels());
    expect(ui.stores.ui.getState().settingsPanelOpen).toBe(true);
    expect(host.textContent).toContain("Wait for this operation");
    releaseAction();
    await expect.poll(() => host.textContent).toContain('Action finished: {"updated":3}');
    expect(operations.map((op) => op.path)).toEqual(["/api/modules/jobs/migration", "/api/modules/jobs/state", "/api/modules/jobs/state", "/api/modules/jobs/actions/rescore"]);
    expect(host.scrollWidth, [...host.querySelectorAll<HTMLElement>("*")].filter((el) => el.getBoundingClientRect().right > host.getBoundingClientRect().right + 1).map((el) => `${el.tagName} ${el.getAttribute("aria-label") ?? el.className}`).join("\n")).toBeLessThanOrEqual(320);
  } finally { releaseAction(); releaseList(); flushSync(() => react.unmount()); ui.dispose(); iframe.remove(); }
});
