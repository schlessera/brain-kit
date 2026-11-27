// Render smoke tests for tab bar, side rail, palette, shortcuts, panes and theme: mount the components in happy-dom and
// assert the DOM they produce. Fixtures are minimal and keyless; nothing here
// touches the network. Shared setup: ./smoke-harness.tsx.
//
// The DOM module import MUST stay first: it registers the happy-dom globals
// before the component module bodies run (./dom.ts explains why, and why
// `screen` must not be used).
import { registerSmokeNavigationDom, unregisterSmokeNavigationDom } from "./smoke-navigation-dom.js";
registerSmokeNavigationDom();

import { installSmokeHarness, changeControlledInput, flushPromises, installActivityFetch, render, renderHook, setHash, useActivityStore, useChatStore, useConnectionStore, useInboxStore, useUIStore } from "./smoke-harness.js";
import { MobileTabBar } from "../../src/components/layout/mobile-tab-bar.js";
import { SideRail } from "../../src/components/layout/side-rail.js";
import { DesktopPalette } from "../../src/components/layout/desktop-palette.js";
import { ThemeToggle, useApplyTheme } from "../../src/components/layout/theme.js";
import { ShortcutSwitch } from "../../src/components/layout/shortcut-switch.js";
import { createUIStore } from "../../src/stores/ui-state.js";
import { describe, expect, mock, test } from "bun:test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { ActivityPage } from "../../src/components/activity/activity-page.js";
import { ToolCallTimeline } from "../../src/components/chat/tool-call-timeline.js";
import type { ToolCall } from "../../src/stores/chat-store.js";
import { useFinePointer } from "../../src/hooks/use-fine-pointer.js";
import { useMediaQuery } from "../../src/hooks/use-media-query.js";
import { ApprovalCard } from "../../src/components/activity/approval-card.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot } from "../../src/root.js";
import { activeChat } from "../../src/stores/chat-store.js";
import { AddForm } from "../../src/components/quick-actions/add-form.js";
import { SearchPanel } from "../../src/components/quick-actions/search-modal.js";
import { SettingsPanel } from "../../src/components/settings/settings-panel.js";
import { FilePanel } from "../../src/components/files/file-panel.js";

installSmokeHarness(unregisterSmokeNavigationDom);

/* ── S5: the first kit consumer, and the theme switch ───────────────────── */

/** Open durable decisions for the badge (#684): what the badge counts now. */
function openDecisions(n: number) {
  const items = Object.fromEntries(Array.from({ length: n }, (_, i) => [`a${i}`, {
    id: `a${i}`, dedupKey: `a${i}`, threadId: "t", queue: "actions", type: "approve", status: "pending", version: 1,
    createdAt: 0, updatedAt: 0, expiresAt: 1, payload: { title: "Harbour fee", detail: "" }, options: [],
  }]));
  useInboxStore.setState({ items } as never);
}

describe("MobileTabBar on the kit TabBar", () => {
  test("renders the five destinations as a tablist, with what needs you as the Actions badge", () => {
    // Run notices are facts, not decisions: they no longer badge (#684).
    useActivityStore.setState({ inbox: [{ id: "n" }] as never });
    openDecisions(3);
    const view = render(<MobileTabBar />);
    const tabs = view.getAllByRole("tab");
    // D52 §1: Sessions takes Graph's slot, and Graph moves into More.
    expect(tabs.map((t) => t.textContent)).toEqual(["Chat", "Sessions", "Actions3", "Files", "More"]);
    // Chat is the active view, so Chat is the amber slot and the only selected tab.
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false", "false"]);
    // The kit's roving tab stop: one slot reachable by Tab, the rest by arrows.
    expect(tabs.filter((t) => t.getAttribute("tabindex") === "0")).toHaveLength(1);
    view.unmount();
    openDecisions(0);
    useActivityStore.setState({ inbox: [] });
  });

  test("a slot switches the view, and More is the kit sheet with Settings, Graph and the acts", async () => {
    useUIStore.getState().setActiveView("chat");
    const view = render(<MobileTabBar />);
    const selected = () => view.getAllByRole("tab").map((t) => t.getAttribute("aria-selected") === "true" ? t.textContent : null).filter(Boolean);
    fireEvent.click(view.getByRole("tab", { name: "Actions" }));
    expect(useUIStore.getState().activeView).toBe("activity");
    expect(view.getByRole("tab", { name: "Actions" }).getAttribute("aria-selected")).toBe("true");
    expect(view.queryByRole("tab", { name: "Graph" }), "Graph is no longer a slot").toBeNull();

    // Sessions and Files are panels that only Chat mounts in full: from
    // Actions they land in Chat with the panel open, and are "here".
    fireEvent.click(view.getByRole("tab", { name: "Sessions" }));
    expect(useUIStore.getState().activeView).toBe("chat");
    expect(useUIStore.getState().sessionPanelOpen).toBe(true);
    expect(selected()).toEqual(["Sessions"]);
    // N1: a destination replaces the open panel with no close step.
    fireEvent.click(view.getByRole("tab", { name: "Files" }));
    expect(useUIStore.getState().sessionPanelOpen).toBe(false);
    expect(useUIStore.getState().filePanelOpen).toBe(true);
    expect(selected()).toEqual(["Files"]);
    // N3: pressing the current destination never closes it.
    fireEvent.click(view.getByRole("tab", { name: "Files" }));
    expect(useUIStore.getState().filePanelOpen, "Files is not a toggle").toBe(true);
    fireEvent.click(view.getByRole("tab", { name: "Chat" }));
    expect(useUIStore.getState().filePanelOpen, "Chat closes the panel").toBe(false);
    expect(selected()).toEqual(["Chat"]);

    expect(view.queryByRole("dialog")).toBeNull();
    fireEvent.click(view.getByRole("tab", { name: "More" }));
    const sheet = view.getByRole("dialog", { name: "More" });
    // Settings and Graph, then the acts, with no redundant Sessions row.
    // Disconnected, so the two that need the host are rows without a
    // handler, listed with the reason and their effect, never omitted.
    expect(sheet.textContent).not.toContain("Sessions");
    const rows = [...sheet.querySelectorAll('[role="button"]')].map((r) => r.textContent);
    expect(rows).toEqual(["Settings", "Graph", "Add a noteWrite it down in the brain", "Brain statisticsDocuments and software versions"]);
    expect(sheet.textContent).toContain("Sync the brainneeds the hostsync");
    expect(sheet.textContent).toContain("Daily briefingneeds the host");
    // Keyless (#1391): the briefing prints no cost.
    expect(sheet.textContent).not.toContain("spends");
    // While the sheet is open, More is the amber slot.
    expect(view.getByRole("tab", { name: "More" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(sheet.querySelector('[role="button"]')!);
    await act(flushPromises);
    expect(useUIStore.getState().settingsPanelOpen).toBe(true);
    expect(view.queryByRole("dialog")).toBeNull();
    // Settings lives in More, so More stays amber while it is open.
    expect(selected()).toEqual(["More"]);

    fireEvent.click(view.getByRole("tab", { name: "More" }));
    fireEvent.click(view.getByRole("button", { name: /^Graph/ }));
    await act(flushPromises);
    expect(useUIStore.getState().activeView).toBe("graph");
    expect(useUIStore.getState().settingsPanelOpen, "Graph replaces Settings").toBe(false);
    expect(selected()).toEqual(["More"]);
    // Files opens over Graph, which mounts its own panel.
    fireEvent.click(view.getByRole("tab", { name: "Files" }));
    expect(useUIStore.getState().activeView).toBe("graph");
    expect(useUIStore.getState().filePanelOpen).toBe(true);

    fireEvent.click(view.getByRole("tab", { name: "More" }));
    expect(view.getByRole("dialog", { name: "More" })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document, { key: "Escape" });
    await act(flushPromises);
    expect(view.queryByRole("dialog")).toBeNull();
    expect(document.activeElement, "Esc returns focus to the More slot").toBe(view.getByRole("tab", { name: "More" }));
    view.unmount();
    useUIStore.getState().setActiveView("chat");
  });

  test("Escape over an open destination dismisses only More", async () => {
    useUIStore.getState().setActiveView("chat");
    useUIStore.getState().openPanel("files");
    // A drawer's own Escape, registered the way SlidePanel and FilePanel do.
    const drawerEscape = mock((e: KeyboardEvent) => { if (e.key === "Escape") useUIStore.getState().setFilePanelOpen(false); });
    document.addEventListener("keydown", drawerEscape);
    const view = render(<MobileTabBar />);
    fireEvent.click(view.getByRole("tab", { name: "More" }));
    expect(view.getByRole("dialog", { name: "More" })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document, { key: "Escape" });
    await act(flushPromises);
    expect(view.queryByRole("dialog"), "More closes").toBeNull();
    expect(useUIStore.getState().filePanelOpen, "the drawer under More stays open").toBe(true);
    // With More closed, Escape reaches the drawer again.
    fireEvent.keyDown(document.activeElement ?? document, { key: "Escape" });
    await act(flushPromises);
    expect(useUIStore.getState().filePanelOpen).toBe(false);
    document.removeEventListener("keydown", drawerEscape);
    view.unmount();
    useUIStore.getState().setActiveView("chat");
  });

  test("a Settings page that refuses to be left keeps every slot and More act from running behind it", async () => {
    useUIStore.getState().setActiveView("chat");
    useUIStore.getState().openPanel("settings");
    let pending: (() => void) | null = null;
    useUIStore.getState().setSettingsNavigationGuard((leave) => { pending = leave; });
    const view = render(<MobileTabBar />);
    fireEvent.click(view.getByRole("tab", { name: "Files" }));
    expect(useUIStore.getState().filePanelOpen, "Files waits for the guard").toBe(false);
    fireEvent.click(view.getByRole("tab", { name: "More" }));
    fireEvent.click(view.getByRole("button", { name: /^Add a note/ }));
    await act(flushPromises);
    expect(useUIStore.getState().addPanelOpen, "Add waits for the guard").toBe(false);
    expect(useUIStore.getState().settingsPanelOpen).toBe(true);
    // Consent: the guard clears itself and the latest navigation runs.
    useUIStore.getState().setSettingsNavigationGuard(null);
    act(() => pending!());
    expect(useUIStore.getState().settingsPanelOpen).toBe(false);
    expect(useUIStore.getState().addPanelOpen).toBe(true);
    view.unmount();
    useUIStore.getState().setActiveView("chat");
  });

  test("More prints the reason that applies: offline, or a running turn", async () => {
    useUIStore.getState().setActiveView("chat");
    useConnectionStore.setState({ wsStatus: "connected" });
    const view = render(<MobileTabBar />);
    fireEvent.click(view.getByRole("tab", { name: "More" }));
    let rows = [...view.getByRole("dialog", { name: "More" }).querySelectorAll('[role="button"]')].map((r) => r.textContent);
    // Connected and quiet: every act runs, and the effects stay printed.
    expect(rows).toEqual([
      "Settings", "Graph", "Add a noteWrite it down in the brain",
      "Daily briefingWhat happened since you looked",
      "Sync the brainPull and push the repositorysync",
      "Brain statisticsDocuments and software versions",
    ]);
    fireEvent.click(view.getByRole("button", { name: /^Add a note/ }));
    await act(flushPromises);
    expect(useUIStore.getState().addPanelOpen, "opening Add opens the form").toBe(true);
    act(() => { useChatStore.getState().addUserMessage(null, "Raft supplies"); useChatStore.getState().startAssistantMessage(null); });
    fireEvent.click(view.getByRole("tab", { name: "More" }));
    const sheet = view.getByRole("dialog", { name: "More" });
    rows = [...sheet.querySelectorAll('[role="button"]')].map((r) => r.textContent);
    // Streaming: Add still opens (REST), the agent acts say why they cannot.
    expect(rows).toEqual(["Settings", "Graph", "Add a noteWrite it down in the brain"]);
    expect(sheet.textContent).toContain("Daily briefinga turn is running");
    expect(sheet.textContent).toContain("Sync the braina turn is runningsync");
    expect(sheet.textContent).toContain("Brain statisticsa turn is running");
    expect(sheet.textContent).not.toContain("needs the host");
    view.unmount();
    act(() => { useChatStore.getState().finishAssistantMessage(null); useChatStore.getState().clearMessages(); });
    useConnectionStore.setState({ wsStatus: "disconnected" });
    useUIStore.getState().setActiveView("chat");
  });

  test("a badge of ten or more reads 9+, and no inbox means no badge", () => {
    openDecisions(12);
    const many = render(<MobileTabBar />);
    // The badge is part of the accessible name, which is the point of it.
    expect(many.getByRole("tab", { name: "Actions 9+" }).textContent).toBe("Actions9+");
    many.unmount();
    openDecisions(0);
    useActivityStore.setState({ inbox: [{ id: "n" }] as never });
    const none = render(<MobileTabBar />);
    expect(none.getByRole("tab", { name: "Actions" }).textContent).toBe("Actions");
    none.unmount();
    useActivityStore.setState({ inbox: [] });
  });
});

/* ── S7: the desktop rail and the ⌘K palette ────────────────────────────── */

describe("SideRail on the kit SideRail", () => {
  test("D52's five destinations in one vertical tablist, the open-decision count as the badge, the socket as the status line", () => {
    openDecisions(2);
    const view = render(<SideRail />);
    const tabs = view.getAllByRole("tab");
    // The test window is 1024px wide, so the rail is expanded: label, badge
    // and printed ⌘ key are the row's text. Graph is no longer a destination.
    expect(tabs.map((t) => t.textContent)).toEqual(["Chat⌘1", "Sessions⌘2", "Actions2⌘3", "Files⌘4", "Settings⌘5"]);
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false", "false"]);
    expect(tabs.filter((t) => t.getAttribute("tabindex") === "0")).toHaveLength(1);
    expect(view.queryByRole("tab", { name: /Graph/ })).toBeNull();
    // Nothing the app cannot back: no spend meter.
    expect(view.container.textContent).not.toContain("$");
    // Disconnected is what the store starts as, and the rail says so.
    expect(view.container.textContent).toContain("offline");
    view.unmount();
    openDecisions(0);
  });

  test("the acts sit under the destinations with the palette's names, cost and reasons, and All commands is a real button", () => {
    const view = render(<SideRail />);
    const acts = view.getByRole("toolbar", { name: "Acts" });
    const buttons = Array.from(acts.querySelectorAll("button"));
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Search the brain",
      "Add a note",
      "Daily briefing, unavailable: needs the host",
    ]);
    // The briefing prints its reason at rest, not on hover, and no cost:
    // it reads the keyless `brain briefing` (#1391).
    expect(buttons[2]!.textContent).toBe("Daily briefingneeds the host");
    const all = view.getByRole("button", { name: "All commands" });
    expect(all.getAttribute("aria-keyshortcuts")).toBe("Meta+K");
    expect(all.textContent).toContain("⌘K");
    view.unmount();
  });

  test("below 900px the rail collapses, each row keeps its name, and only the effect-free acts stay", () => {
    const realMatchMedia = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
    try {
      const view = render(<SideRail />);
      const tabs = view.getAllByRole("tab");
      expect(tabs.map((t) => t.getAttribute("aria-label"))).toEqual(["Chat", "Sessions", "Actions", "Files", "Settings"]);
      expect(tabs.map((t) => t.textContent)).toEqual(["", "", "", "", ""]);
      // The briefing is reached through All commands when collapsed (D52 §1).
      const acts = view.getByRole("toolbar", { name: "Acts" });
      expect(Array.from(acts.querySelectorAll("button")).map((b) => b.getAttribute("aria-label"))).toEqual(["Search the brain", "Add a note"]);
      expect(view.getByRole("button", { name: "All commands" }).textContent).toBe("⌘K");
      view.unmount();
    } finally {
      window.matchMedia = realMatchMedia;
    }
  });

  test("a destination switches the view or opens its panel, and an open panel is the amber row", () => {
    const view = render(<SideRail />);
    const tab = (name: string) => view.getByRole("tab", { name: new RegExp(`^${name}`) });
    const selected = () => view.getAllByRole("tab").filter((t) => t.getAttribute("aria-selected") === "true");
    fireEvent.click(tab("Actions"));
    expect(useUIStore.getState().activeView).toBe("activity");
    // Sessions opens the drawer in Chat, and is the amber row while it is open.
    fireEvent.click(tab("Sessions"));
    expect(useUIStore.getState().activeView).toBe("chat");
    expect(useUIStore.getState().sessionPanelOpen).toBe(true);
    expect(selected()).toEqual([tab("Sessions")]);
    fireEvent.click(tab("Files"));
    expect(useUIStore.getState().filePanelOpen).toBe(true);
    expect(useUIStore.getState().sessionPanelOpen).toBe(false);
    expect(selected()).toEqual([tab("Files")]);
    // Graph is no destination: while it shows, no row is amber.
    act(() => useUIStore.getState().setActiveView("graph"));
    expect(selected()).toEqual([]);
    view.unmount();
  });

  test("⌘1–⌘5 (or Ctrl) reach Chat, Sessions, Actions, Files and Settings from anywhere; a bare digit does not", () => {
    const view = render(<SideRail />);
    act(() => useUIStore.getState().setActiveView("activity"));
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    expect(useUIStore.getState().activeView).toBe("chat");
    expect(useUIStore.getState().sessionPanelOpen).toBe(true);
    fireEvent.keyDown(window, { key: "3", ctrlKey: true });
    expect(useUIStore.getState().activeView).toBe("activity");
    expect(useUIStore.getState().sessionPanelOpen).toBe(false);
    // Actions draws no Files, so ⌘4 lands in Chat to show it (D52 N1).
    fireEvent.keyDown(window, { key: "4", metaKey: true });
    expect(useUIStore.getState().filePanelOpen).toBe(true);
    expect(useUIStore.getState().activeView).toBe("chat");
    fireEvent.keyDown(window, { key: "4", metaKey: true });
    expect(useUIStore.getState().filePanelOpen, "⌘4 again leaves Files open (D52 N3)").toBe(true);
    fireEvent.keyDown(window, { key: "1" });
    expect(useUIStore.getState().filePanelOpen).toBe(true);
    fireEvent.keyDown(window, { key: "5", metaKey: true });
    expect(useUIStore.getState().settingsPanelOpen).toBe(true);
    expect(useUIStore.getState().filePanelOpen, "Settings replaces Files").toBe(false);
    fireEvent.keyDown(window, { key: "5", metaKey: true });
    expect(useUIStore.getState().settingsPanelOpen, "⌘5 again leaves Settings open (D52 N3)").toBe(true);
    act(() => useUIStore.getState().setActiveView("activity"));
    fireEvent.keyDown(window, { key: "1", metaKey: true });
    expect(useUIStore.getState().activeView).toBe("chat");
    expect(useUIStore.getState().settingsPanelOpen).toBe(false);
    // Nothing is bound past the five, so Graph has no chord.
    fireEvent.keyDown(window, { key: "6", metaKey: true });
    expect(useUIStore.getState().activeView).toBe("chat");
    view.unmount();
  });

  test("Search and Add open their panels in Chat even mid-turn; the briefing runs only when the host is quiet", () => {
    act(() => useUIStore.getState().setActiveView("activity"));
    const view = render(<SideRail />);
    const actButton = (name: RegExp) => view.getByRole("button", { name });
    // Disconnected: the briefing is a stop that says why and runs nothing.
    const briefing = actButton(/^Daily briefing/);
    expect(briefing.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(briefing);
    expect(useUIStore.getState().whatsupPanelOpen).toBe(false);
    expect(useUIStore.getState().activeView).toBe("activity");

    act(() => {
      useConnectionStore.setState({ wsStatus: "connected" });
      useChatStore.getState().startAssistantMessage(null);
    });
    expect(activeChat(useChatStore.getState()).isStreaming).toBe(true);
    expect(actButton(/^Daily briefing/).getAttribute("aria-label")).toBe("Daily briefing, unavailable: a turn is running");
    // REST, so a running turn does not stop them; each lands in Chat.
    fireEvent.click(actButton(/^Search the brain/));
    expect(useUIStore.getState().activeView).toBe("chat");
    expect(useUIStore.getState().searchPanelOpen).toBe(true);
    act(() => useUIStore.getState().setActiveView("activity"));
    fireEvent.click(actButton(/^Add a note/));
    expect(useUIStore.getState().activeView).toBe("chat");
    expect(useUIStore.getState().addPanelOpen).toBe(true);

    act(() => useChatStore.getState().finishAssistantMessage(null));
    expect(actButton(/^Daily briefing/).getAttribute("aria-label")).toBe("Daily briefing");
    fireEvent.click(actButton(/^Daily briefing/));
    expect(useUIStore.getState().whatsupPanelOpen).toBe(true);
    view.unmount();
  });

  test("unsaved Settings hold the acts and Sessions until the guard lets them leave, then they run", () => {
    useConnectionStore.setState({ wsStatus: "connected" });
    const view = render(<SideRail />);
    act(() => useUIStore.getState().openSettings("modules"));
    let leave: (() => void) | null = null;
    act(() => useUIStore.getState().setSettingsNavigationGuard((go) => { leave = go; }));
    const ui = () => useUIStore.getState();
    for (const run of [
      () => fireEvent.click(view.getByRole("button", { name: /^Search the brain/ })),
      () => fireEvent.click(view.getByRole("button", { name: /^Daily briefing/ })),
      () => fireEvent.keyDown(window, { key: "2", metaKey: true }),
    ]) {
      leave = null;
      run();
      // Nothing opens over Settings, and the briefing does not start, before consent.
      expect(leave, "the guard was asked").not.toBeNull();
      expect(ui().settingsPanelOpen).toBe(true);
      expect([ui().searchPanelOpen, ui().whatsupPanelOpen, ui().sessionPanelOpen]).toEqual([false, false, false]);
    }
    // Consent, as the modules tab gives it: clear the guard, then leave.
    act(() => { ui().setSettingsNavigationGuard(null); leave!(); });
    expect(ui().settingsPanelOpen).toBe(false);
    expect(ui().activeView).toBe("chat");
    expect(ui().sessionPanelOpen, "the held route completes").toBe(true);
    view.unmount();
  });

  test("All commands opens its own root's palette and no other mounted root's", async () => {
    const a = createBrainUiRoot({ storage: null });
    const b = createBrainUiRoot({ storage: null });
    const view = render(
      <div>
        <div data-root="a"><BrainUiProvider root={a}><SideRail /><DesktopPalette /></BrainUiProvider></div>
        <div data-root="b"><BrainUiProvider root={b}><SideRail /><DesktopPalette /></BrainUiProvider></div>
      </div>
    );
    const inA = view.container.querySelector<HTMLElement>('[data-root="a"]')!;
    const allA = Array.from(inA.querySelectorAll("button")).find((el) => el.getAttribute("aria-keyshortcuts") === "Meta+K")!;
    allA.focus();
    fireEvent.click(allA);
    expect(a.stores.ui.getState().paletteOpen).toBe(true);
    expect(b.stores.ui.getState().paletteOpen).toBe(false);
    const dialogs = view.getAllByRole("dialog", { name: "Command palette" });
    expect(dialogs).toHaveLength(1);
    expect(inA.contains(dialogs[0]!)).toBe(true);
    // Focus enters the query, and esc hands it back to the button.
    expect(document.activeElement).toBe(dialogs[0]!.querySelector("input"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(view.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(allA));
    view.unmount();
    a.dispose();
    b.dispose();
  });
});

describe("DesktopPalette on the kit CommandPalette", () => {
  test("⌘K opens it with the query focused, typing filters, ⏎ runs the selected row and closes, esc closes", async () => {
    const view = render(<DesktopPalette />);
    expect(view.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const dialog = view.getByRole("dialog", { name: "Command palette" });
    expect(dialog).toBeTruthy();
    const names = view.getAllByRole("option").map((o) => o.textContent);
    // Jump to: the five destinations with their remapped keys, then keyless
    // Storage and Graph, then New chat. Sessions is one row, not two (D52 §1).
    expect(names.slice(0, 8).map((n) => n?.replace(/⏎/g, ""))).toEqual([
      "Chat⌘1", "Sessions⌘2", "Actions⌘3", "Files⌘4", "Settings⌘5", "Storage", "Graph", "New chat",
    ]);
    expect(names.filter((n) => n?.includes("Sessions"))).toHaveLength(1);
    // Every other route is still here, the rail's acts included.
    for (const label of ["Search the brain", "Brain statistics", "Sync the brain", "Daily briefing", "Add a note"]) {
      expect(names.some((n) => n?.includes(label))).toBe(true);
    }
    // Disconnected: Sync, the briefing and stats are listed DISABLED with the
    // reason, never omitted (D37).
    const sync = view.getByRole("option", { name: /Sync the brain/ });
    expect(sync.getAttribute("aria-disabled")).toBe("true");
    expect(sync.textContent).toContain("needs the host");
    expect(sync.getAttribute("tabindex")).toBeNull();
    // The query is a real input, and it holds focus on open.
    const input = view.getByRole("combobox") as HTMLInputElement;
    expect(document.activeElement).toBe(input);

    changeControlledInput(input, "gr");
    expect(view.getAllByRole("option").map((o) => o.textContent)).toEqual(["Graph⏎"]);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(useUIStore.getState().activeView).toBe("graph"));
    expect(view.queryByRole("dialog")).toBeNull();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    // The query was reset with the close.
    expect(view.getAllByRole("option").length).toBeGreaterThan(7);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(view.queryByRole("dialog")).toBeNull();
    view.unmount();
  });

  test("⌘K again, or a click on the scrim, closes it and hands focus back to what held it", async () => {
    const view = render(<div><button type="button">before</button><DesktopPalette /></div>);
    const before = view.getByRole("button", { name: "before" });
    before.focus();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(document.activeElement).toBe(view.getByRole("combobox"));
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(view.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(before));
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const scrim = view.getByRole("dialog").querySelector(".bk-overlay-scrim")!;
    fireEvent.pointerDown(scrim);
    expect(view.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(before));
    view.unmount();
  });

  test("with the socket live and no turn streaming, Sync carries its effect chip in its name", async () => {
    useConnectionStore.setState({ wsStatus: "connected" });
    // Both halves of the precondition, stated. `why` in desktop-routes.ts
    // needs `connected` AND `!isStreaming`, and this test used to set only the
    // first — so it passed on whatever the previous test left behind. The
    // afterEach above now clears the chat store, and this asserts the state
    // the title claims rather than trusting it.
    expect(activeChat(useChatStore.getState()).isStreaming).toBe(false);
    const view = render(<DesktopPalette />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(view.getByRole("option", { name: "Sync the brain, sync" }).getAttribute("aria-disabled")).not.toBe("true");
    expect(view.getByRole("option", { name: /Daily briefing/ }).textContent).not.toContain("spends");
    fireEvent.click(view.getByRole("option", { name: /Daily briefing/ }));
    await waitFor(() => expect(useUIStore.getState().whatsupPanelOpen).toBe(true));
    expect(view.queryByRole("dialog")).toBeNull();
    view.unmount();
  });
});

/* ── D36: single-key shortcuts, focus-scoped ────────────────────────────── */

describe("single-key shortcuts (D36)", () => {
  function pending(id: string, name = "Bash"): ToolCall {
    return {
      id,
      name,
      input: { command: "ls" },
      inputJson: '{"command":"ls"}',
      status: "pending_approval",
      approvalKind: "command",
    } as ToolCall;
  }

  function Harness({ calls, onApproval }: { calls: ToolCall[]; onApproval: (id: string, ok: boolean, always?: boolean) => void }) {
    return (
      <div>
        <ToolCallTimeline toolCalls={calls} onApproval={onApproval} />
        <textarea data-composer="" aria-label="composer" />
      </div>
    );
  }

  test("a and d decide the approval card that holds focus, and the keys are printed on its buttons", () => {
    const decided: unknown[] = [];
    const view = render(<Harness calls={[pending("t1")]} onApproval={(...a) => decided.push(a)} />);
    const card = view.getByRole("group", { name: "Approval: Bash" });
    expect(view.getByRole("button", { name: /^Allow/ }).textContent).toBe("Allow a");
    expect(view.getByRole("button", { name: /^Deny/ }).textContent).toBe("Deny d");

    // Bare letters elsewhere do nothing: the scope is the card.
    fireEvent.keyDown(document.body, { key: "a" });
    expect(decided).toEqual([]);

    card.focus();
    fireEvent.keyDown(card, { key: "a", metaKey: true });
    expect(decided).toEqual([]);
    fireEvent.keyDown(card, { key: "d" });
    expect(decided).toEqual([["t1", false, undefined]]);
    // The last pending card hands focus to the composer.
    expect(document.activeElement).toBe(view.getByLabelText("composer"));
    view.unmount();
  });

  test("deciding one of two cards hands focus to the next one, not the top of the document", () => {
    const view = render(<Harness calls={[pending("t1"), pending("t2", "Write")]} onApproval={() => {}} />);
    const first = view.getByRole("group", { name: "Approval: Bash" });
    first.focus();
    fireEvent.keyDown(first, { key: "a" });
    expect(document.activeElement).toBe(view.getByRole("group", { name: "Approval: Write" }));
    view.unmount();
  });

  test("the Settings switch turns the letters off and the printed keys go with them", () => {
    const decided: unknown[] = [];
    const view = render(
      <>
        <ShortcutSwitch />
        <Harness calls={[pending("t1")]} onApproval={(...a) => decided.push(a)} />
      </>
    );
    const toggle = view.getByRole("switch", { name: /Single-key shortcuts/ });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(useUIStore.getState().singleKeyShortcuts).toBe(false);
    expect(view.getByRole("button", { name: /^Allow/ }).textContent).toBe("Allow");
    const card = view.getByRole("group", { name: "Approval: Bash" });
    card.focus();
    fireEvent.keyDown(card, { key: "a" });
    expect(decided).toEqual([]);
    // The buttons still work; only the letters are off.
    fireEvent.click(view.getByRole("button", { name: /^Allow/ }));
    expect(decided).toEqual([["t1", true, undefined]]);
    useUIStore.getState().setSingleKeyShortcuts(true);
    view.unmount();
  });

  test("the preference persists under the root's storage prefix", () => {
    const backing = new Map<string, string>();
    const storage = {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    } as unknown as Storage;
    const env = { storage: () => storage, storageKey: (k: string) => `t:${k}` };
    const first = createUIStore(env);
    expect(first.getState().singleKeyShortcuts).toBe(true);
    first.getState().setSingleKeyShortcuts(false);
    expect(backing.get("t:brain-single-key-shortcuts")).toBe("off");
    expect(createUIStore(env).getState().singleKeyShortcuts).toBe(false);
  });

  test("j and k move inside the inbox, d dismisses the focused card and focus moves on", async () => {
    const calls = installActivityFetch((url) => {
      if (url.includes("/activity/inbox") && !url.includes("/ack")) {
        return Response.json({
          intents: [1, 2].map((n) => ({
            id: n,
            runId: `run-${n}`,
            spanId: null,
            kind: "failure",
            tag: "t",
            title: `Intent ${n}`,
            body: "",
            status: "pending",
            acknowledged: false,
            createdAt: Date.now(),
          })),
        });
      }
      return undefined;
    });
    const page = render(<ActivityPage />);
    await act(flushPromises);
    const cards = page.getAllByRole("button", { name: /Intent \d/ });
    expect(cards).toHaveLength(2);
    expect(page.getAllByRole("button", { name: "Dismiss · d" })).toHaveLength(2);
    expect(page.getByText("j / k move · d dismiss · ⏎ open")).toBeTruthy();

    cards[0]!.focus();
    fireEvent.keyDown(cards[0]!, { key: "j" });
    expect(document.activeElement).toBe(cards[1]);
    fireEvent.keyDown(cards[1]!, { key: "j" });
    expect(document.activeElement).toBe(cards[0]);
    fireEvent.keyDown(cards[0]!, { key: "k" });
    expect(document.activeElement).toBe(cards[1]);

    fireEvent.keyDown(cards[1]!, { key: "d" });
    await act(flushPromises);
    expect(useActivityStore.getState().inbox.map((i) => i.id)).toEqual([1]);
    expect(calls.some((url) => url.includes("/activity/inbox/2/ack") || url.includes("inbox") && url.includes("2"))).toBe(true);
    expect(document.activeElement).toBe(page.getByRole("button", { name: /Intent 1/ }));

    fireEvent.keyDown(document.activeElement!, { key: "d" });
    await act(flushPromises);
    expect(useActivityStore.getState().inbox).toEqual([]);
    // The drained section becomes the empty state and its heading takes
    // focus (D37) — never the document top. No receipt: dismissal without
    // undo is silent (sixth pass §4), the row leaving is the receipt.
    expect(document.activeElement).toBe(page.getByRole("heading", { name: "Nothing is waiting on you" }));
    expect(page.queryByText("Dismissed")).toBeNull();
    expect(page.queryByText("Intent 1")).toBeNull();
    page.unmount();
  });
});

/* ── #86: printed keys follow the pointer, the bindings do not ──────────── */

describe("printed keys follow the pointer (#86)", () => {
  const FINE = "(any-pointer: fine)";
  /** A `matchMedia` that answers the pointer query as given and every other query for real. */
  function withPointer<T>(fine: boolean, run: () => T): T {
    const real = window.matchMedia;
    window.matchMedia = ((q: string) =>
      q === FINE ? { matches: fine, media: q, addEventListener() {}, removeEventListener() {} } : real.call(window, q)) as never;
    try {
      return run();
    } finally {
      window.matchMedia = real;
    }
  }
  function pending(id: string): ToolCall {
    return { id, name: "Bash", input: { command: "ls" }, inputJson: '{"command":"ls"}', status: "pending_approval", approvalKind: "command" } as ToolCall;
  }

  test("useFinePointer reports (any-pointer: fine) live and re-renders when it flips", () => {
    const real = window.matchMedia;
    let listener: ((e: { matches: boolean }) => void) | undefined;
    const removed: string[] = [];
    // One list per query, as a browser keeps one: the hook reads `matches`
    // off the list it subscribed to when the change event arrives.
    const list = {
      matches: true,
      media: FINE,
      addEventListener(_: string, fn: typeof listener) { listener = fn; },
      removeEventListener(type: string) { removed.push(type); },
    };
    window.matchMedia = ((q: string) => (q === FINE ? list : { matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
    try {
      const hook = renderHook(() => useFinePointer());
      expect(hook.result.current).toBe(true);
      // Unpairing the mouse: the list flips and the subscriber re-renders.
      list.matches = false;
      act(() => listener!({ matches: false }));
      expect(hook.result.current).toBe(false);
      list.matches = true;
      act(() => listener!({ matches: true }));
      expect(hook.result.current).toBe(true);
      hook.unmount();
      expect(removed).toEqual(["change"]);
    } finally {
      window.matchMedia = real;
    }
  });

  test("with no matchMedia the pointer reads fine (fail open) while a width query still reads false", () => {
    const real = window.matchMedia;
    window.matchMedia = undefined as never;
    try {
      const fine = renderHook(() => useFinePointer());
      expect(fine.result.current).toBe(true);
      const wide = renderHook(() => useMediaQuery("(min-width: 900px)"));
      expect(wide.result.current).toBe(false);
      fine.unmount();
      wide.unmount();
    } finally {
      window.matchMedia = real;
    }
  });

  test("a coarse-only pointer drops the rail's and the palette's ⌘n caps and keeps ⌘1–⌘5 working", () => {
    withPointer(false, () => {
      const view = render(<div><SideRail /><DesktopPalette /></div>);
      // Still expanded (the width query is real and the window is 1024px),
      // so the row's text is the label alone — no key to a finger.
      expect(view.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Chat", "Sessions", "Actions", "Files", "Settings"]);
      expect(view.container.textContent).not.toMatch(/⌘[1-5]/);
      // All commands prints ⌘K on every pointer (D36 addendum).
      expect(view.getByRole("button", { name: "All commands" }).textContent).toContain("⌘K");
      // Tapped open, the palette prints no destination chord either.
      fireEvent.click(view.getByRole("button", { name: "All commands" }));
      expect(view.getAllByRole("option").slice(0, 5).map((o) => o.textContent?.replace("⏎", ""))).toEqual(["Chat", "Sessions", "Actions", "Files", "Settings"]);
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      act(() => useUIStore.getState().setActiveView("activity"));
      fireEvent.keyDown(window, { key: "1", metaKey: true });
      expect(useUIStore.getState().activeView).toBe("chat");
      fireEvent.keyDown(window, { key: "2", metaKey: true });
      expect(useUIStore.getState().sessionPanelOpen).toBe(true);
      fireEvent.keyDown(window, { key: "3", metaKey: true });
      expect(useUIStore.getState().activeView).toBe("activity");
      fireEvent.keyDown(window, { key: "4", metaKey: true });
      expect(useUIStore.getState().filePanelOpen).toBe(true);
      fireEvent.keyDown(window, { key: "5", metaKey: true });
      expect(useUIStore.getState().settingsPanelOpen).toBe(true);
      expect(useUIStore.getState().filePanelOpen).toBe(false);
      view.unmount();
    });
    useUIStore.getState().setActiveView("chat");
  });

  test("a coarse-only pointer drops the a / d caps on the transcript's approval buttons, and the letters still decide", () => {
    const decided: unknown[] = [];
    withPointer(false, () => {
      const view = render(
        <div>
          <ToolCallTimeline toolCalls={[pending("t1")]} onApproval={(...a) => decided.push(a)} />
          <textarea data-composer="" aria-label="composer" />
        </div>
      );
      expect(view.getByRole("button", { name: /^Allow/ }).textContent).toBe("Allow");
      expect(view.getByRole("button", { name: /^Deny/ }).textContent).toBe("Deny");
      const card = view.getByRole("group", { name: "Approval: Bash" });
      card.focus();
      fireEvent.keyDown(card, { key: "a" });
      expect(decided).toEqual([["t1", true, undefined]]);
      view.unmount();
    });
  });

  test("the Actions-pane approval card prints a / d only with a fine pointer, and the letters still decide without one", () => {
    const fine = render(<ApprovalCard tool={pending("t1")} origin="this conversation" keys onDecide={() => {}} />);
    expect(fine.container.textContent).toContain("allow a");
    expect(fine.container.textContent).toContain("deny d");
    fine.unmount();

    const decided: unknown[] = [];
    withPointer(false, () => {
      const view = render(<ApprovalCard tool={pending("t1")} origin="this conversation" keys onDecide={(...a) => decided.push(a)} />);
      expect(view.container.textContent).not.toContain("allow a");
      expect(view.container.textContent).not.toContain("deny d");
      const card = view.getByRole("group", { name: "Approval: Bash" });
      card.focus();
      fireEvent.keyDown(card, { key: "d" });
      expect(decided).toEqual([[false, undefined]]);
      view.unmount();
    });
  });

  test("the Actions pane prints its j / k / d keys only with a fine pointer, and they still act without one (#100)", async () => {
    installActivityFetch((url) => {
      if (url.includes("/activity/inbox") && !url.includes("/ack")) {
        return Response.json({
          intents: [1, 2, 3].map((n) => ({
            id: n,
            runId: `run-${n}`,
            spanId: null,
            kind: "failure",
            tag: "t",
            title: `Intent ${n}`,
            body: "",
            status: "pending",
            acknowledged: false,
            createdAt: Date.now(),
          })),
        });
      }
      return undefined;
    });
    // Async, so the pointer is swapped by hand rather than through `withPointer`,
    // whose finally would restore it before the page's effects settle.
    // One live list for the pointer query, so the test can pair a trackpad
    // mid-session and watch the page follow it.
    const real = window.matchMedia;
    const listeners = new Set<(e: { matches: boolean }) => void>();
    const pointer = {
      matches: false,
      media: FINE,
      addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => void listeners.add(fn),
      removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => void listeners.delete(fn),
    };
    window.matchMedia = ((q: string) => (q === FINE ? pointer : real.call(window, q))) as never;
    try {
      const page = render(<ActivityPage />);
      await act(flushPromises);
      const cards = page.getAllByRole("button", { name: /Intent \d/ });
      expect(cards).toHaveLength(3);
      // Neither footer (the below-laptop line nor the laptop column's), and
      // no card carries its "· d" hint.
      expect(page.container.textContent).not.toContain("j / k move");
      expect(page.queryAllByRole("button", { name: "Dismiss · d" })).toHaveLength(0);
      expect(page.getAllByRole("button", { name: "Dismiss" })).toHaveLength(3);

      // The bindings are the keyboard's, not the pointer's: they still act.
      cards[0]!.focus();
      fireEvent.keyDown(cards[0]!, { key: "j" });
      expect(document.activeElement).toBe(cards[1]);
      fireEvent.keyDown(cards[1]!, { key: "k" });
      expect(document.activeElement).toBe(cards[0]);
      fireEvent.keyDown(cards[0]!, { key: "d" });
      await act(flushPromises);
      expect(useActivityStore.getState().inbox.map((i) => i.id)).toEqual([2, 3]);

      // A trackpad arrives: all three print again, exactly as D36 draws them.
      pointer.matches = true;
      act(() => listeners.forEach((fn) => fn({ matches: true })));
      expect(page.getByText("j / k move · d dismiss · ⏎ open")).toBeTruthy();
      expect(page.getByText("j / k move · d dismiss")).toBeTruthy();
      expect(page.getAllByRole("button", { name: "Dismiss · d" })).toHaveLength(2);

      // And the pointer never overrides the switch: with single-key shortcuts
      // off, a fine pointer prints nothing either.
      act(() => useUIStore.getState().setSingleKeyShortcuts(false));
      expect(page.container.textContent).not.toContain("j / k move");
      expect(page.queryAllByRole("button", { name: "Dismiss · d" })).toHaveLength(0);
      page.unmount();
    } finally {
      window.matchMedia = real;
      useUIStore.getState().setSingleKeyShortcuts(true);
    }
  });

  test("the search and add panels print their key hints only with a fine pointer", () => {
    const search = render(<SearchPanel open onClose={() => {}} />);
    expect(search.getByText(/to pick/).textContent).toContain("to open");
    expect(search.container.querySelectorAll("kbd").length).toBeGreaterThan(0);
    search.unmount();

    const draft = { content: "Remember", title: "", type: "", tags: "" };
    const onSave = mock(() => {});
    const form = () => (
      <AddForm state="editing" draft={draft} knownTypes={[]} error="" savedPath="" indexed={undefined} indexing={false} contentRef={{ current: null }} onDraft={() => {}} onSave={onSave} onRetryIndex={() => {}} onAddAnother={() => {}} onClose={() => {}} />
    );
    const add = render(form());
    expect(add.container.textContent).toContain("to save");
    add.unmount();

    withPointer(false, () => {
      const touchSearch = render(<SearchPanel open onClose={() => {}} />);
      expect(touchSearch.getByText(/Type at least 2 characters/)).toBeTruthy();
      expect(touchSearch.container.textContent).not.toContain("to pick");
      expect(touchSearch.container.querySelectorAll("kbd")).toHaveLength(0);
      touchSearch.unmount();

      const touchAdd = render(form());
      expect(touchAdd.container.textContent).not.toContain("to save");
      expect(touchAdd.container.querySelectorAll("kbd")).toHaveLength(0);
      // The binding is untouched: Ctrl+↵ still saves.
      fireEvent.keyDown(touchAdd.getByPlaceholderText("idea, reading"), { key: "Enter", ctrlKey: true });
      expect(onSave).toHaveBeenCalledTimes(1);
      touchAdd.unmount();
    });
  });
});

/* ── D37: the desktop panes (the test window is 1024px, so `laptop:` shapes render) ── */

describe("desktop panes (D37)", () => {
  test("Settings is a pane with a section column; Appearance & input holds the theme and the switch", () => {
    const onClose = mock(() => {});
    const view = render(<SettingsPanel open onClose={onClose} />);
    const tabs = view.getAllByRole("tab").map((t) => t.getAttribute("aria-label") ?? t.textContent);
    expect(tabs).toEqual(["Appearance & input", "Models", "Voice", "Accounts", "Skills", "Modules", "Storage", "Security", "Devices & agents"]);
    fireEvent.click(view.getByRole("tab", { name: "Appearance & input" }));
    expect(useUIStore.getState().settingsTab).toBe("appearance");
    expect(view.getByRole("radiogroup", { name: "Theme" })).toBeTruthy();
    expect(view.getByRole("switch", { name: "Single-key shortcuts" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  test("Files is three panes: the tree, the reading pane with its close, and nothing invented in the rail", async () => {
    const onClose = mock(() => {});
    globalThis.fetch = (async () => Response.json({ entries: [] })) as unknown as typeof fetch;
    const view = render(<FilePanel open onClose={onClose} />);
    await act(flushPromises);
    const pane = view.getByRole("region", { name: "Files" });
    expect(pane.textContent).toContain("Files");
    expect(pane.textContent).toContain("j / k move · ← → fold · ⏎ open");
    // The design's backlinks and provenance have no data behind them: not drawn.
    expect(pane.textContent).not.toContain("Linked from");
    expect(pane.textContent).not.toContain("Provenance");
    // The rail column is mounted with no file open (sixth pass §3a), empty.
    expect(view.getByRole("complementary", { name: "Evidence" }).textContent).toBe("");
    fireEvent.click(view.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  test("Actions is a list beside a detail pane that asks for a run until one is picked", async () => {
    installActivityFetch();
    const page = render(<ActivityPage />);
    await act(flushPromises);
    expect(page.getByRole("region", { name: "Actions queue" })).toBeTruthy();
    expect(page.getByText("Pick a run")).toBeTruthy();
    act(() => setHash("#/activity/run%20one"));
    await act(flushPromises);
    expect(page.queryByText("Pick a run")).toBeNull();
    expect(page.getByRole("heading", { name: "run one" })).toBeTruthy();
    page.unmount();
  });
});

describe("theme preference", () => {
  test("the toggle writes the choice to the store and AppShell's effect writes it to <html>", () => {
    function Shell() {
      useApplyTheme();
      return <ThemeToggle />;
    }
    const view = render(<Shell />);
    expect(document.documentElement.dataset.theme).toBe("dark");
    const radios = view.getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["System", "Paper", "Dark"]);
    fireEvent.click(view.getByRole("radio", { name: "Paper" }));
    expect(useUIStore.getState().theme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(view.getByRole("radio", { name: "Paper" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(view.getByRole("radio", { name: "System" }));
    expect(document.documentElement.dataset.theme).toBe("system");
    view.unmount();
  });

  test("a root persists the preference under its own storage prefix and restores it", () => {
    const backing = new Map<string, string>();
    const storage = {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    } as unknown as Storage;
    const env = { storage: () => storage, storageKey: (k: string) => `t:${k}` };
    const first = createUIStore(env);
    expect(first.getState().theme).toBe("dark");
    first.getState().setTheme("light");
    expect(backing.get("t:brain-theme")).toBe("light");
    // A second root on the same storage sees the choice; garbage does not count.
    expect(createUIStore(env).getState().theme).toBe("light");
    backing.set("t:brain-theme", "neon");
    expect(createUIStore(env).getState().theme).toBe("dark");
    // No storage at all (SSR, stories) is fine and stays dark.
    expect(createUIStore().getState().theme).toBe("dark");
  });
});
