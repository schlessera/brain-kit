import { describe, test, expect } from "bun:test";
import { isUserCancel } from "../src/lib/passkeys";
import { useUIStore } from "../src/stores/ui-store";

describe("isUserCancel", () => {
  test("treats NotAllowedError and AbortError as user cancel", () => {
    const notAllowed = new Error("The operation either timed out or was not allowed");
    notAllowed.name = "NotAllowedError";
    expect(isUserCancel(notAllowed)).toBe(true);

    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(isUserCancel(abort)).toBe(true);
  });

  test("real errors are not cancels", () => {
    expect(isUserCancel(new Error("HTTP 401"))).toBe(false);
    expect(isUserCancel("NotAllowedError")).toBe(false);
    expect(isUserCancel(undefined)).toBe(false);
  });
});

describe("ui-store settings panel", () => {
  test("toggle opens exclusively and closeAllPanels clears it", () => {
    const store = useUIStore.getState();
    store.toggleSessionPanel();
    expect(useUIStore.getState().sessionPanelOpen).toBe(true);

    useUIStore.getState().toggleSettingsPanel();
    const s = useUIStore.getState();
    expect(s.settingsPanelOpen).toBe(true);
    expect(s.sessionPanelOpen).toBe(false);

    useUIStore.getState().closeAllPanels();
    expect(useUIStore.getState().settingsPanelOpen).toBe(false);
  });

  test("openSettings selects a tab and closes the other panels", () => {
    useUIStore.getState().toggleSessionPanel();

    useUIStore.getState().openSettings("security");
    const s = useUIStore.getState();
    expect(s.settingsPanelOpen).toBe(true);
    expect(s.settingsTab).toBe("security");
    expect(s.sessionPanelOpen).toBe(false);

    useUIStore.getState().setSettingsTab("models");
    expect(useUIStore.getState().settingsTab).toBe("models");

    useUIStore.getState().closeAllPanels();
  });
});
