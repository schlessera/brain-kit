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

describe("ui-store security panel", () => {
  test("toggle opens exclusively and closeAllPanels clears it", () => {
    const store = useUIStore.getState();
    store.toggleSessionPanel();
    expect(useUIStore.getState().sessionPanelOpen).toBe(true);

    useUIStore.getState().toggleSecurityPanel();
    const s = useUIStore.getState();
    expect(s.securityPanelOpen).toBe(true);
    expect(s.sessionPanelOpen).toBe(false);

    useUIStore.getState().closeAllPanels();
    expect(useUIStore.getState().securityPanelOpen).toBe(false);
  });
});
