// Pressing a destination (D52 N3, #1078): the store tells a press of the
// destination already shown from a press that goes somewhere, and the hook
// answers each recorded press once, in the root it was made in. The hook's
// cases run in a child process with happy-dom registered, so its DOM globals
// never reach another test file.
import { describe, expect, test } from "bun:test";
import { createUIStore, type UIState } from "../src/stores/ui-state.js";

const CHILD_MARKER = "BRAIN_UI_REACT_DESTINATION_PRESS_CHILD";

/** What a press must leave alone when it only records itself. */
const placed = (s: UIState) => ({
  view: s.activeView,
  panels: [s.sessionPanelOpen, s.filePanelOpen, s.settingsPanelOpen, s.searchPanelOpen, s.addPanelOpen, s.syncPanelOpen, s.whatsupPanelOpen],
  tab: s.settingsTab,
});

if (!process.env[CHILD_MARKER]) {
  describe("pressDestination", () => {
    test("a destination not shown is gone to, and no press is recorded", () => {
      const ui = createUIStore();
      ui.getState().pressDestination("activity");
      expect(ui.getState().activeView).toBe("activity");
      ui.getState().pressDestination("files");
      expect(ui.getState().filePanelOpen, "Files from Actions lands in Chat with Files drawn").toBe(true);
      expect(ui.getState().activeView).toBe("chat");
      expect(ui.getState().destinationPress).toBeNull();
    });

    test("the destination shown records a press and changes nothing else", () => {
      const ui = createUIStore();
      for (const [destination, setup] of [
        ["chat", () => {}],
        ["activity", () => ui.getState().setActiveView("activity")],
        ["sessions", () => ui.getState().openPanel("sessions")],
        ["files", () => ui.getState().openPanel("files")],
        ["settings", () => ui.getState().openSettings("security")],
      ] as const) {
        ui.getState().setActiveView("chat");
        setup();
        const before = placed(ui.getState());
        const n = ui.getState().destinationPress?.n ?? 0;
        ui.getState().pressDestination(destination, { keyboard: destination === "files" });
        expect(placed(ui.getState()), `${destination}: nothing moved`).toEqual(before);
        expect(ui.getState().destinationPress, `${destination}: one press recorded`).toEqual({ destination, n: n + 1, keyboard: destination === "files" });
      }
    });

    test("Chat under an act's panel is not shown, so its press replaces the panel", () => {
      const ui = createUIStore();
      ui.getState().setSearchPanelOpen(true);
      ui.getState().pressDestination("chat");
      expect(ui.getState().searchPanelOpen).toBe(false);
      expect(ui.getState().destinationPress).toBeNull();
    });

    test("a panel flag over a view that does not draw it is not shown", () => {
      const ui = createUIStore();
      ui.getState().setActiveView("activity");
      ui.getState().setSessionPanelOpen(true);
      ui.getState().pressDestination("sessions");
      expect(ui.getState().destinationPress, "nothing drawn, nothing to answer").toBeNull();
      expect(ui.getState().activeView, "it goes to Chat, where Sessions is drawn").toBe("chat");
    });
  });

  test("the hook's cases pass in an isolated process", async () => {
    const proc = Bun.spawn(["bun", "test", import.meta.path, "--timeout", "30000"], {
      cwd: import.meta.dir,
      env: { ...process.env, [CHILD_MARKER]: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) throw new Error(`Isolated destination press tests failed (${exitCode})\n${stdout}${stderr}`);
    expect(`${stdout}${stderr}`).toMatch(/\b3 pass\b/);
  });
} else {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const { act, renderHook } = await import("@testing-library/react");
  const { BrainUiProvider } = await import("../src/root-context.js");
  const { createBrainUiRoot } = await import("../src/root.js");
  const { useDestinationPress } = await import("../src/hooks/use-destination-press.js");
  type Root = ReturnType<typeof createBrainUiRoot>;

  /** The hook under a provider whose root `swap` replaces without remounting it. */
  function mount(first: Root) {
    const calls: number[] = [];
    let current = first;
    const view = renderHook(() => useDestinationPress("chat", (p) => calls.push(p.n)), {
      wrapper: ({ children }: { children: React.ReactNode }) => <BrainUiProvider root={current}>{children}</BrainUiProvider>,
    });
    const swap = (next: Root) => { current = next; view.rerender(); };
    return { calls, swap };
  }

  test("each press of the destination is answered once", () => {
    const a = createBrainUiRoot({ storage: null });
    const { calls } = mount(a);
    act(() => a.stores.ui.getState().pressDestination("chat"));
    act(() => a.stores.ui.getState().pressDestination("activity"));
    act(() => a.stores.ui.getState().pressDestination("activity"));
    expect(calls, "Chat answers its own press, not Actions'").toEqual([1]);
    a.dispose();
  });

  test("a replacement root's first press is answered, though it counts from one again", () => {
    const a = createBrainUiRoot({ storage: null });
    const b = createBrainUiRoot({ storage: null });
    const { calls, swap } = mount(a);
    act(() => a.stores.ui.getState().pressDestination("chat"));
    swap(b);
    act(() => b.stores.ui.getState().pressDestination("chat"));
    expect(calls).toEqual([1, 1]);
    a.dispose();
    b.dispose();
  });

  test("a press the replacement root already holds is not replayed", () => {
    const a = createBrainUiRoot({ storage: null });
    const b = createBrainUiRoot({ storage: null });
    for (let i = 0; i < 5; i++) b.stores.ui.getState().pressDestination("chat");
    const { calls, swap } = mount(a);
    swap(b);
    expect(calls, "switching roots answers nothing").toEqual([]);
    act(() => b.stores.ui.getState().pressDestination("chat"));
    expect(calls).toEqual([6]);
    a.dispose();
    b.dispose();
  });
}
