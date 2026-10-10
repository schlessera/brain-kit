/// <reference types="@vitest/browser-playwright" />
import { afterAll, afterEach, beforeAll, expect, test, vi, type TestContext } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { createRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot } from "../../src/root.js";
import { AppShell } from "../../src/components/layout/app-shell.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { ShareMenu } from "../../src/components/share/share-menu.js";
import { SettingsPanel } from "../../src/components/settings/settings-panel.js";
import { OneTimeAgentCredentialDialog } from "../../src/components/settings/one-time-agent-credential.js";
import { ZoomViewer } from "../../src/components/viewer/zoom-viewer.js";
import { FileViewerRaw } from "../../src/components/files/file-viewer-raw.js";
import { CopyButton } from "../../src/components/chat/copy-button.js";
import { MarkdownPre } from "../../src/components/chat/brain-markdown-code.js";
import { MermaidBlock } from "../../src/components/chat/mermaid-block.js";
import { ZoomableImage } from "../../src/components/images/zoomable-image.js";
import { SubagentView } from "../../src/components/chat/subagent-view.js";
import { TrackChip } from "../../src/components/chat/track-chip.js";
import { CommandPalette } from "../../src/components/chat/command-palette.js";
import { ToolCallTimeline, ToolCallTimelineCell } from "../../src/components/chat/tool-call-timeline.js";
import { ClampedPre, ToolOutputView } from "../../src/components/chat/tool-views.js";
import { CONTROL_RING, ROW_RING, ring } from "../../../ui-kit/stories/_stage.js";
import type { ToolCall } from "../../src/stores/chat-store.js";
import type { PendingTrack } from "../../src/lib/track-uploads.js";

// Actual migrated components and shell; only transports and host data are fixtures.
class FixtureSocket {
  readyState = 0;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  send() {}
  close() { this.readyState = 3; }
}
const credential = { id: "eumaeus", label: "Eumaeus", cookie: "odysseus-fixture-cookie", expiresAt: Date.UTC(2026, 6, 19) };
let styles: HTMLStyleElement;
beforeAll(async () => {
  styles = document.createElement("style");
  styles.textContent = await commands.formConsumerStyles();
  document.head.append(styles);
});
afterAll(() => styles.remove());
afterEach(() => vi.unstubAllGlobals());
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

async function mount(ctx: TestContext, width = 390) {
  const viewport = { width: innerWidth, height: innerHeight };
  const theme = document.documentElement.dataset.theme;
  const outer = await commands.formViewport(width, 800);
  await page.viewport(width, 800);
  vi.stubGlobal("WebSocket", FixtureSocket);
  const writes: string[] = [];
  const ui = createBrainUiRoot({ storage: null, request: async (url, init) => {
    const path = new URL(String(url), "http://fixture.invalid").pathname;
    if (init?.method === "POST" && path.endsWith("/auth/principals")) {
      writes.push(path);
      return Response.json(credential);
    }
    return Response.json({ entries: [], sessions: [], principals: [], providers: [], backends: {},
      slugs: {}, models: [], live: [], history: [], intents: [] });
  } });
  ui.stores.ui.getState().setTheme("dark");
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0";
  document.body.append(host);
  function Scene() {
    const [zoom, setZoom] = useState(false);
    return <AppShell><ChatPage />
      <button data-test-zoom="" onClick={() => setZoom(true)}>View Ithaca route</button>
      <button data-test-mask="" onClick={() => ui.stores.mask.getState().open({ requestId: "raft-mask", imagePath: "raft.png" })}>Mark raft</button>
      <button data-test-subagent="" onClick={() => ui.stores.ui.getState().pushSubagentView("rigging")}>Inspect rigging</button>
      {zoom && <ZoomViewer label="Ithaca route" onClose={() => setZoom(false)} actions={<ShareMenu title="Share route" options={[{ id: "copy", label: "Copy route", run: async () => true }]} />}><svg width="200" height="100"><text x="10" y="50">Troy → Ithaca</text></svg></ZoomViewer>}
    </AppShell>;
  }
  const renderer = createRoot(host);
  ctx.onTestFinished(async () => {
    flushSync(() => renderer.unmount());
    ui.dispose(); host.remove();
    document.documentElement.dataset.theme = theme;
    await page.viewport(viewport.width, viewport.height);
    await commands.formViewport(outer.width - 100, outer.height - 120);
  });
  flushSync(() => renderer.render(<BrainUiProvider root={ui}><Scene /></BrainUiProvider>));
  await frame();
  const tab = (name: string) => [...host.querySelectorAll<HTMLElement>('nav[aria-label="Primary"] [role="tab"]')]
    .find(el => el.textContent?.trim() === name)!;
  const overlay = (selector: string) => document.querySelector<HTMLElement>(selector)!;
  return { host, ui, writes, tab, overlay };
}

async function trap(dialog: HTMLElement) {
  expect(dialog.contains(document.activeElement), "focus enters migrated overlay").toBe(true);
  const stops = [...dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex="0"]')]
    .filter(el => el.tabIndex >= 0 && !el.matches(':disabled, [aria-disabled="true"]') && el.getClientRects().length > 0);
  expect(stops.length, "real nonempty focus stops").toBeGreaterThan(1);
  stops.at(-1)!.focus();
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement, "forward wrap inside migrated overlay").toBe(stops[0]);
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  expect(document.activeElement, "backward wrap inside migrated overlay").toBe(stops.at(-1));
  for (let i = 0; i < stops.length + 2; i++) {
    await userEvent.keyboard("{Tab}");
    expect(dialog.contains(document.activeElement), "Tab stays inside migrated overlay").toBe(true);
  }
}

test("Files → More: native sheet wins, Escape closes only the topmost and returns each opener", async ctx => {
  // Mutation: restore focus synchronously in Overlay cleanup; Files opener assertion fails.
  const s = await mount(ctx, 320);
  s.tab("Files").focus(); await userEvent.click(s.tab("Files"));
  const files = s.overlay('[data-panel="Files"]');
  expect(files.contains(document.activeElement), "focus enters Files").toBe(true);
  const moreTab = s.tab("More");
  moreTab.focus(); await userEvent.click(moreTab);
  const more = s.overlay('[data-overlay-site="more"]');
  expect(more.closest("[inert]"), "late More dialog itself stays live").toBeNull();
  expect(more.matches("dialog:modal"), "More is a native sheet above Files").toBe(true);
  await trap(more);
  await userEvent.keyboard("{Escape}"); await frame();
  expect(s.host.querySelector('[data-overlay-site="more"]'), "only More closed").toBeNull();
  expect(s.ui.stores.ui.getState().filePanelOpen, "Files stays open under More").toBe(true);
  expect(document.activeElement, "More opener returned").toBe(moreTab);
  await userEvent.keyboard("{Escape}"); await frame();
  expect(s.host.querySelector('[data-panel="Files"]'), "second Escape closes Files").toBeNull();
  expect(document.activeElement, "Files opener returned").toBe(s.tab("Files"));
});

for (const width of [390, 800]) test(`${width}: destination panel keeps navigation live by hit and Tab`, async ctx => {
  // Mutation: remove data-bk-keep-live from nav; navigation hit assertion fails.
  const s = await mount(ctx, width);
  const navigation = width < 480 ? s.tab("Sessions").closest("nav")! : s.host.querySelector<HTMLElement>('nav[data-bk-keep-live].tablet\\:flex')!;
  const opener = width < 480 ? s.tab("Sessions") : navigation.querySelector<HTMLElement>('[role="tab"][aria-label^="Sessions"]')!;
  expect(opener, "live Sessions opener exists").not.toBeNull();
  opener.focus(); await userEvent.click(opener);
  const panel = s.overlay('[data-panel="Sessions"]');
  expect(panel.contains(document.activeElement), "focus enters destination").toBe(true);
  const box = opener.getBoundingClientRect();
  expect(opener.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)), "navigation remains hit-testable").toBe(true);
  let reached = false;
  for (let i = 0; i < 25; i++) {
    await userEvent.keyboard("{Tab}");
    if (navigation.contains(document.activeElement)) { reached = true; break; }
  }
  expect(reached, "Tab reaches live navigation from panel").toBe(true);
  expect(s.host.querySelector("[data-composer]")?.closest("[inert]"), "content is inert").not.toBeNull();
  await userEvent.keyboard("{Escape}"); await frame();
  expect(document.activeElement, "destination opener returned").toBe(opener);
});

test("Search act panel traps focus and covers the phone bar", async ctx => {
  // Mutation: set SlidePanel modal=false for acts; native panel assertion fails.
  const s = await mount(ctx);
  const opener = s.host.querySelector<HTMLElement>('[data-bk-button][aria-label="Search the brain"]')
    ?? [...s.host.querySelectorAll<HTMLElement>('[role="button"]')].find(el => el.textContent?.includes("Search…"))!;
  expect(opener, "real Search opener").toBeTruthy();
  opener.focus(); await userEvent.click(opener);
  const search = s.overlay('[data-panel="Search"]');
  expect(search.matches("dialog:modal"), "Search is modal").toBe(true);
  await trap(search);
  const box = s.tab("More").getBoundingClientRect();
  expect(s.tab("More").contains(document.elementFromPoint(box.x + 10, box.y + 10)), "Search makes bar inert").toBe(false);
  await userEvent.keyboard("{Escape}"); await frame();
  expect(document.activeElement, "Search opener returned").toBe(opener);
});

test("Settings mint: credential stays above the drawer, requires acknowledgement, and returns into Settings", async ctx => {
  // Mutation: remove the credential saved-acknowledgement guard; disabled Done assertion fails.
  const s = await mount(ctx, 800);
  flushSync(() => { s.ui.stores.ui.getState().setSettingsTab("devices"); s.ui.stores.ui.getState().openPanel("settings"); });
  await expect.poll(() => s.host.querySelector("#agent-label")).not.toBeNull();
  await userEvent.fill(s.host.querySelector<HTMLInputElement>("#agent-label")!, "Eumaeus");
  const mint = [...s.host.querySelectorAll<HTMLElement>('[role="button"]')].find(el => el.textContent === "Create agent credential")!;
  mint.focus(); await userEvent.click(mint);
  await expect.poll(() => s.host.querySelector('[role="alertdialog"]')).not.toBeNull();
  const dialog = s.overlay('[role="alertdialog"]');
  expect(s.writes, "actual mint request").toEqual(["/api/auth/principals"]);
  expect(dialog.closest("[inert]"), "late credential dialog itself stays live").toBeNull();
  expect(dialog.matches("dialog:modal"), "credential in top layer").toBe(true);
  expect(document.activeElement?.textContent, "credential initially focuses Copy").toBe("Copy credential");
  await trap(dialog);
  const done = page.getByRole("button", { name: "Done", exact: true }).element() as HTMLElement;
  expect(done.getAttribute("aria-disabled"), "Done requires saved acknowledgement").toBe("true");
  await userEvent.keyboard("{Escape}"); await frame();
  expect(dialog.isConnected && dialog.matches(":modal"), "locked Escape keeps credential open").toBe(true);
  await userEvent.click(dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
  await userEvent.click(done); await frame();
  expect(s.host.querySelector('[role="alertdialog"]')).toBeNull();
  expect(s.ui.stores.ui.getState().settingsPanelOpen, "Settings remains open").toBe(true);
  expect(s.overlay('[data-panel="Settings"]').contains(document.activeElement), "focus returns into Settings").toBe(true);
});

test("credential arriving over More wins the top layer; Cmd-K cannot cover it", async ctx => {
  // Mutation: delete palette openModal guard; palette exclusion assertion fails.
  const s = await mount(ctx, 800);
  // More is phone-only; resize first, then use a real tap. Afterwards the width
  // permits Cmd-K, so the guard (not the phone-width restriction) is exercised.
  await page.viewport(390, 800); await commands.formViewport(390, 800); await frame();
  s.tab("More").focus(); await userEvent.click(s.tab("More"));
  const more = s.overlay('[data-overlay-site="more"]');
  await page.viewport(800, 800); await commands.formViewport(800, 800); await frame();
  expect(more.matches(":modal"), "sheet remains visible across width change").toBe(true);
  await s.ui.stores.principal.getState().mintAgent("Eumaeus", 7); await frame();
  const dialog = s.overlay('[role="alertdialog"]');
  await trap(dialog);
  const copy = page.getByRole("button", { name: "Copy credential", exact: true }).element();
  const box = copy.getBoundingClientRect();
  expect(copy.contains(document.elementFromPoint(box.x + 5, box.y + 5)), "credential paints over sheet").toBe(true);
  await userEvent.keyboard("{Meta>}k{/Meta}"); await frame();
  expect(s.ui.stores.ui.getState().paletteOpen, "palette excluded by existing modal").toBe(false);
  await userEvent.keyboard("{Escape}"); await frame();
  expect(dialog.matches(":modal"), "credential ignores Escape").toBe(true);
  await userEvent.click(dialog.querySelector("input")!);
  await userEvent.click(page.getByRole("button", { name: "Done", exact: true })); await frame();
  expect(more.matches(":modal"), "sheet stays open after credential").toBe(true);
  expect(more.contains(document.activeElement), "focus returns to sheet").toBe(true);
});

test("palette respects width, traps focus, returns on dismiss and hands actions focus after closing", async ctx => {
  // Mutation: omit the deferred palette action; Search opening assertion fails.
  const s = await mount(ctx, 390);
  await userEvent.keyboard("{Meta>}k{/Meta}"); await frame();
  expect(s.host.querySelector('[data-palette]'), "no hidden modal below 480").toBeNull();
  await page.viewport(900, 800); await commands.formViewport(900, 800); await frame();
  const opener = s.host.querySelector<HTMLElement>('button[data-test-zoom]')!;
  opener.focus(); await userEvent.keyboard("{Meta>}k{/Meta}"); await frame();
  const palette = s.overlay('[data-palette]');
  expect(document.activeElement, "palette query initially focused").toBe(palette.querySelector("input"));
  await trap(palette);
  await userEvent.keyboard("{Escape}"); await frame();
  expect(document.activeElement, "palette dismiss returns opener").toBe(opener);
  await userEvent.keyboard("{Meta>}k{/Meta}"); await frame();
  await userEvent.fill(s.overlay('[data-palette]').querySelector("input")!, "Search the brain");
  await userEvent.keyboard("{Enter}"); await frame();
  expect(s.host.querySelector('[data-palette]'), "run closes palette").toBeNull();
  expect(s.host.querySelector('[data-panel="Search"]'), "deferred action opens Search").not.toBeNull();
  expect(s.overlay('[data-panel="Search"]').contains(document.activeElement), "action focuses new Search after close").toBe(true);
});

for (const site of ["zoom", "mask"] as const) test(`${site} fullscreen has a name, traps, closes with Escape and returns focus`, async ctx => {
  // Mutation: make the site's onClose a no-op; Escape dismissal assertion fails.
  const s = await mount(ctx);
  if (site === "mask") { await commands.overlayImageFixture(true); ctx.onTestFinished(() => commands.overlayImageFixture(false)); }
  const opener = s.host.querySelector<HTMLElement>(`[data-test-${site}]`)!;
  opener.focus(); await userEvent.click(opener); await frame();
  const dialog = s.overlay('[data-bk-overlay="fullscreen"]');
  const name = dialog.getAttribute("aria-label") ?? document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent;
  expect(name?.trim(), "fullscreen resolves a nonempty accessible name").toBe(site === "zoom" ? "Ithaca route" : "Mark the area to change");
  await trap(dialog);
  if (site === "zoom") {
    const controls = [...dialog.querySelectorAll("button")];
    expect(controls.length, "all zoom controls including Share are covered").toBe(5);
    for (const control of controls) {
      expect(control.getAttribute("aria-label"), "toolbar control has an accessible name").toBeTruthy();
      expect(control.getBoundingClientRect().width, "toolbar target width").toBeGreaterThanOrEqual(44);
      expect(control.getBoundingClientRect().height, "toolbar target height").toBeGreaterThanOrEqual(44);
    }
  }
  if (site === "mask") expect(dialog.dataset.theme, "photograph controls pin dark theme").toBe("dark");
  await userEvent.keyboard("{Escape}"); await frame();
  expect(document.querySelector('[data-bk-overlay="fullscreen"]'), "Escape dismisses fullscreen").toBeNull();
  expect(document.activeElement, "fullscreen opener returned").toBe(opener);
});

test("subagent Escape pops one level without remounting and focuses the new Back button", async ctx => {
  // Mutation: close the whole stack on Escape; one-level stack assertion fails.
  const s = await mount(ctx);
  const opener = s.host.querySelector<HTMLElement>("[data-test-subagent]")!;
  opener.focus(); await userEvent.click(opener); await frame();
  const dialog = s.overlay('[data-bk-overlay="fullscreen"]');
  flushSync(() => s.ui.stores.ui.getState().pushSubagentView("sail"));
  await userEvent.keyboard("{Escape}"); await frame();
  expect(s.ui.stores.ui.getState().subagentStack, "Escape pops one level").toEqual(["rigging"]);
  expect(s.overlay('[data-bk-overlay="fullscreen"]'), "same overlay remains mounted").toBe(dialog);
  expect(document.activeElement, "new level Back focused").toBe(dialog.querySelector('[aria-label="Back"]'));
  await userEvent.keyboard("{Escape}"); await frame();
  expect(document.activeElement, "level-one opener returned").toBe(opener);
});

for (const destination of ["files", "settings"] as const) test(`${destination} pane: Escape respects inner prevention and modal stacking`, async ctx => {
  // Mutations: delete the pane listener, ignore defaultPrevented, or ignore openModal.
  const s = await mount(ctx, 1280);
  flushSync(() => {
    if (destination === "settings") s.ui.stores.ui.getState().setSettingsTab("appearance");
    s.ui.stores.ui.getState().openPanel(destination);
  });
  await frame();
  const title = destination === "files" ? "Files" : "Settings";
  const pane = () => s.host.querySelector<HTMLElement>(`section[aria-label="${title}"]`);
  expect(pane(), "pane is open").not.toBeNull();
  const prevented = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  prevented.preventDefault(); document.dispatchEvent(prevented); await frame();
  expect(pane(), "inner prevented Escape keeps pane open").not.toBeNull();
  if (destination === "settings") {
    flushSync(() => s.ui.stores.principal.setState({ mintPending: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await frame();
    expect(pane(), "protected Settings pane keeps Escape inert").not.toBeNull();
    flushSync(() => s.ui.stores.principal.setState({ mintPending: false }));
  }
  flushSync(() => s.ui.stores.ui.getState().setPaletteOpen(true));
  await frame();
  const palette = s.overlay('[aria-label="Command palette"]');
  expect(palette.closest("[inert]"), "late palette dialog itself stays live").toBeNull();
  // A document-targeted Escape cannot bypass the modal; real focus Escape closes it.
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await frame();
  expect(pane(), "document Escape under modal keeps pane open").not.toBeNull();
  await userEvent.keyboard("{Escape}"); await frame();
  expect(s.host.querySelector('[aria-label="Command palette"]'), "Escape closes palette only").toBeNull();
  expect(pane(), "pane stays open after modal Escape").not.toBeNull();
  pane()!.focus(); await userEvent.keyboard("{Escape}"); await frame();
  expect(pane(), "Escape closes desktop pane").toBeNull();
});

test("late palette over a destination drawer remains live and closes before the drawer", async ctx => {
  // Mutation: let the destination inert walker mark the newly inserted modal itself.
  const s = await mount(ctx, 800);
  flushSync(() => {
    s.ui.stores.ui.getState().setSettingsTab("devices");
    s.ui.stores.ui.getState().openPanel("settings");
  });
  await frame();
  await expect.poll(() => s.host.querySelector("#agent-label"), { message: "Settings fixture finishes before palette" }).not.toBeNull();
  const drawer = s.overlay('[data-panel="Settings"]');
  expect(drawer.matches('section[data-bk-overlay="panel"]'), "destination drawer is non-modal").toBe(true);
  expect(s.host.querySelector("[data-composer]")?.closest("[inert]"), "destination walker has marked background content").not.toBeNull();
  const opener = drawer.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')!;
  expect(opener, "selected Settings tab exists before palette").not.toBeNull();
  opener.focus();
  flushSync(() => s.ui.stores.ui.getState().setPaletteOpen(true));
  await frame();
  const palette = s.overlay('[aria-label="Command palette"]');
  expect(palette.closest("[inert]"), "late palette above destination drawer itself stays live").toBeNull();
  expect(palette.matches("dialog:modal"), "palette above drawer is native modal").toBe(true);
  await trap(palette);
  await userEvent.keyboard("{Escape}"); await frame();
  expect(s.host.querySelector('[aria-label="Command palette"]'), "Escape dismisses palette above drawer").toBeNull();
  expect(drawer.isConnected, "destination drawer survives palette Escape").toBe(true);
  expect(document.activeElement, "palette returns to the drawer opener").toBe(opener);
});

test("credential focus fallback finds Settings outside its own parent", async ctx => {
  // Mutation: scope the fallback query to dialog.parentElement.
  const viewport = { width: innerWidth, height: innerHeight };
  const outer = await commands.formViewport(1280, 800); await page.viewport(1280, 800);
  const ui = createBrainUiRoot({ storage: null, request: async () => Response.json({ principals: [], providers: [], models: [], backends: {} }) });
  ui.stores.ui.getState().setSettingsTab("appearance");
  const host = document.createElement("div"); document.body.append(host);
  const opener = document.createElement("button"); opener.textContent = "Mint Eumaeus credential";
  host.append(opener); opener.focus();
  const renderer = createRoot(host.appendChild(document.createElement("div")));
  ctx.onTestFinished(async () => {
    flushSync(() => renderer.unmount()); ui.dispose(); host.remove();
    await page.viewport(viewport.width, viewport.height);
    await commands.formViewport(outer.width - 100, outer.height - 120);
  });
  flushSync(() => renderer.render(<BrainUiProvider root={ui}>
    <SettingsPanel open onClose={() => {}} />
    <div data-credential-host=""><OneTimeAgentCredentialDialog /></div>
  </BrainUiProvider>));
  await frame(); opener.focus();
  flushSync(() => ui.stores.principal.setState({ oneTimeCredential: credential }));
  const dialog = host.querySelector<HTMLElement>('[role="alertdialog"]')!;
  expect(dialog, "credential opens in its own parent").not.toBeNull();
  expect(dialog.parentElement!.querySelector('[aria-label="Settings"]'), "Settings is outside the credential parent").toBeNull();
  opener.disabled = true;
  await userEvent.click(dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
  await userEvent.click(page.getByRole("button", { name: "Done", exact: true }));
  await frame();
  const selected = host.querySelector<HTMLElement>('[aria-label="Settings"] [role="tab"][aria-selected="true"]')!;
  expect(selected, "selected Settings tab exists").not.toBeNull();
  expect(document.activeElement, "credential fallback finds Settings through ownerDocument").toBe(selected);
});


// #1379 batch 3: measure the actual consumer controls in all native pointer scenes.


const output = Array.from({ length: 20 }, (_, i) => `Ithaca provision ${i}`).join("\n");
const tool: ToolCall = { id: "rigging", name: "Read", input: { file_path: "ithaca/rigging.md" }, inputJson: "{}", output, status: "complete" };
const failedTrack = { id: "route", name: "ithaca.gpx", file: new File(["route"], "ithaca.gpx"), state: "failed", error: "Try again" } satisfies PendingTrack;
const noop = () => {};
const controls: { site: string; name: string | RegExp; view: ReactNode; row?: boolean; sm?: boolean; reveal?: boolean; expand?: boolean; openTool?: boolean; coarseReveal?: boolean }[] = [
  { site: "default copy", name: "Copy", view: <div className="group/copy relative p-16"><CopyButton getText={() => output} /></div>, sm: true, reveal: true, coarseReveal: true },
  { site: "labelled copy", name: "Copy file content", view: <FileViewerRaw content={output} fileName="ithaca-rigging.md" /> },
  { site: "code head copy", name: "Copy", view: <MarkdownPre><code>{output}</code></MarkdownPre> },
  { site: "image expand", name: "Open image", view: <ZoomableImage src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='100'/%3E" alt="Ithaca route" />, sm: true, reveal: true },
  ...["Open diagram", "Share diagram", "Show source", "Copy"].map(name => ({ site: `diagram ${name}`, name, view: <MermaidBlock source="graph LR; Troy-->Ithaca" />, sm: true, reveal: true })),
  { site: "subagent back", name: "Back", view: <SubagentView spanId="rigging" backRef={createRef<HTMLButtonElement>()} />, sm: true },
  { site: "track retry", name: "Retry ithaca.gpx", view: <TrackChip track={failedTrack} onRetry={noop} onRemove={noop} /> },
  { site: "track remove", name: "Remove ithaca.gpx", view: <TrackChip track={failedTrack} onRetry={noop} onRemove={noop} /> },
  { site: "command row", name: /\/sync Sync brain repository/, view: <div className="relative mt-24"><CommandPalette filter="sync" onSelect={noop} /></div>, row: true },
  { site: "timeline summary", name: /1 step/, view: <ToolCallTimeline toolCalls={[tool]} onApproval={noop} />, row: true },
  { site: "timeline header", name: /Read/, view: <ToolCallTimeline toolCalls={[tool]} onApproval={noop} live />, row: true },
  { site: "timeline subagent row", name: /^Inspect rigging/, view: <ToolCallTimeline toolCalls={[{ ...tool, id: "rigging-agent", name: "Agent", input: { description: "Inspect rigging" } }]} onApproval={noop} live />, row: true },
  { site: "timeline output copy", name: "Copy output", view: <ToolCallTimeline toolCalls={[tool]} onApproval={noop} live />, sm: true, openTool: true },
  { site: "timeline hide", name: "Hide steps", view: <ToolCallTimeline toolCalls={[tool]} onApproval={noop} />, expand: true },
  { site: "timeline cell hide", name: "Hide steps", view: <ToolCallTimelineCell toolCalls={[tool]} toolIndex={0} live={false} collapsed={false} onCollapse={noop} onExpand={noop} onApproval={noop} /> },
  { site: "clamped output", name: "Show all (20 lines)", view: <ClampedPre text={output} /> },
  { site: "clamped prose", name: "Show all (20 lines)", view: <ToolOutputView tool={{ ...tool, name: "Agent" }} /> },
  { site: "read disclosure", name: "20 lines read", view: <ToolOutputView tool={tool} /> },
];
for (const theme of ["dark", "light"]) for (const control of controls) for (const property of (control.row ? ["name", "focus"] : ["name", "target", "focus"]) as ("name" | "target" | "focus")[]) {
  test(`batch 3 ${theme} ${control.site}: ${property}`, async ctx => {
    const beforeTheme = document.documentElement.dataset.theme;
    const ui = createBrainUiRoot({ storage: null, request: async () => Response.json({}) });
    const span = { spanId: "rigging-agent", runId: "crossing", kind: "subagent" as const, origin: "session" as const, name: "Agent", startedAt: Date.UTC(2026, 6, 12, 9, 42), endedAt: Date.UTC(2026, 6, 12, 9, 42, 1), outcome: "success" as const, subagent: { description: "Inspect rigging" } };
    ui.stores.activity.setState({ spans: { crossing: { "rigging-agent": span } }, spanRun: { "rigging-agent": "crossing" } });
    const host = document.createElement("div");
    host.style.cssText = "position:relative;width:280px;margin:24px;padding:8px;background:var(--bk-color-surface);color:var(--bk-color-ink)";
    document.body.append(host);
    const renderer = createRoot(host);
    ctx.onTestFinished(() => { flushSync(() => renderer.unmount()); ui.dispose(); host.remove(); document.documentElement.dataset.theme = beforeTheme; });
    document.documentElement.dataset.theme = theme;
    flushSync(() => renderer.render(<BrainUiProvider root={ui}>{control.view}</BrainUiProvider>));
    if (control.openTool) await userEvent.click(page.getByRole("button", { name: /Read/ }));
    if (control.expand) await userEvent.click(page.getByRole("button", { name: /1 step/ }));
    const query = page.getByRole("button", { name: control.name, exact: typeof control.name === "string" });
    await expect.element(query).toBeInTheDocument();
    const button = query.element() as HTMLButtonElement;
    if (property === "target" && !control.row) {
      const box = button.getBoundingClientRect();
      const expected = control.sm && !matchMedia("(any-pointer: coarse)").matches ? 28 : 44;
      expect(box.height, "consumer control target height").toBeGreaterThanOrEqual(expected);
      if (control.sm || control.site.startsWith("track")) expect(box.width, "consumer icon target width").toBeGreaterThanOrEqual(expected);
      if (control.reveal && matchMedia("(pointer: coarse)").matches) {
        await userEvent.hover(document.body, { position: { x: 1, y: 1 } });
        const wrapper = button.closest<HTMLElement>(".opacity-0")!;
        if (control.coarseReveal) expect(getComputedStyle(wrapper).opacity, "coarse copy wrapper reveals control").toBe("1");
        else {
          await expect.poll(() => getComputedStyle(wrapper).opacity, { message: "media toolbar stays concealed at rest" }).toBe("0");
          button.focus(); await userEvent.keyboard("{ArrowRight}");
          await expect.poll(() => getComputedStyle(wrapper).opacity, { message: "coarse keyboard focus reveals media control" }).toBe("1");
        }
        const reach = button.getBoundingClientRect();
        expect(button.contains(document.elementFromPoint(reach.x + reach.width / 2, reach.y + reach.height / 2)), "coarse target is reachable").toBe(true);
      }
    }
    if (property === "focus") {
      if (control.reveal) await userEvent.hover(document.body, { position: { x: 1, y: 1 } });
      button.focus(); await userEvent.keyboard("{ArrowRight}");
      expect(ring(button), "consumer keyboard focus ring").toEqual(control.row ? ROW_RING : CONTROL_RING);
      if (control.reveal) await expect.poll(() => getComputedStyle(button.closest<HTMLElement>(".opacity-0")!).opacity, { message: "focus-within reveals media control" }).toBe("1");
    }
  });
}

// #1433: the actual unrecoverable credential remains protected above More.
test("credential swipe is bounded and lower More is inert", async ctx => {
  const s = await mount(ctx,320);
  await userEvent.click(s.tab("More"));
  const lower = s.overlay('[data-overlay-site="more"]').querySelector<HTMLElement>('.bk-overlay-surface')!;
  flushSync(() => s.ui.stores.principal.setState({oneTimeCredential:credential}));
  await frame();
  const dialog = s.overlay('[role="alertdialog"]');
  const sheet = dialog.querySelector<HTMLElement>('.bk-overlay-surface')!;
  const focus = document.activeElement;
  expect(focus?.textContent, "credential focuses Copy").toContain("Copy credential");
  const r = sheet.getBoundingClientRect();
  const p = {x:r.left+80,y:r.top+20};
  await commands.sheetInput("pen", [{type:"down",...p,t:0},{type:"move",x:p.x,y:p.y+200,t:200}]);
  expect(new DOMMatrix(getComputedStyle(sheet).transform).m42, "credential rubber-band bound").toBe(12);
  expect(document.activeElement,"credential keeps Copy focus").toBe(focus);
  await commands.sheetInput("pen", [{type:"up",x:p.x,y:p.y+200,t:400}]);
  await frame();
  expect(s.ui.stores.principal.getState().oneTimeCredential, "credential state retained").toEqual(credential);
  expect(new DOMMatrix(getComputedStyle(lower).transform).m42, "lower sheet does not move").toBe(0);
  // Native input is hit-tested against the top layer. Also deliver a lower
  // DOM event to prove Overlay's own topmost guard, independent of inertness.
  let pointerId = 0;
  dialog.addEventListener("pointerdown",event => {pointerId=event.pointerId;},{once:true});
  await commands.sheetInput("pen",[{type:"down",...p,t:0}]);
  ctx.onTestFinished(() => commands.sheetInput("pen",[{type:"up",...p,t:500}]));
  const l = lower.getBoundingClientRect();
  for (const [type,y] of [["pointerdown",l.top+20],["pointermove",l.top+150]] as const)
    lower.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerType:"pen",pointerId,clientX:l.left+80,clientY:y}));
  expect(new DOMMatrix(getComputedStyle(lower).transform).m42, "lower guard rejects tracking").toBe(0);
  await commands.sheetInput("pen",[{type:"up",...p,t:400}]);
  expect(s.overlay('[data-overlay-site="more"]'),"lower More retained").not.toBeNull();
});

test("More swipe restores its tab and leaves Files open", async ctx => {
  const s = await mount(ctx,320);
  await userEvent.click(s.tab("Files")); await userEvent.click(s.tab("More"));
  const more = s.overlay('[data-overlay-site="more"]');
  const sheet = more.querySelector<HTMLElement>('.bk-overlay-surface')!;
  const r = sheet.getBoundingClientRect(); const p = {x:r.left+80,y:r.top+20};
  await commands.sheetInput("touch",[{type:"down",...p,t:0},{type:"move",x:p.x,y:p.y+121,t:200},{type:"up",x:p.x,y:p.y+121,t:400}]);
  await frame();
  expect(document.querySelector('[data-overlay-site="more"]'),"More swipe closes only More").toBeNull();
  expect(s.overlay('[data-panel="Files"]'),"Files remains open").not.toBeNull();
  expect(document.activeElement,"More tab receives swipe return focus").toBe(s.tab("More"));
});
