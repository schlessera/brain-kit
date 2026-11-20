// happy-dom registration for the SlidePanel dismissal render tests, a sibling
// of `dom.ts` on purpose: that module's body runs once per process, so a
// second test file importing it after `render-smoke` has unregistered would
// get no DOM. This module is imported by `slide-panel.test.tsx` alone, so its
// body runs exactly when that file loads, and the file's `afterAll`
// unregisters again before the next test file — the same containment
// contract, kept per file. Import it FIRST, before any component module.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

/**
 * Register the DOM. The module body does it once, for the component imports
 * that follow; a repeated run of the file (`--rerun-each`, the determinism
 * job) reuses the loaded modules, so the file registers again before its
 * tests through this.
 */
export function registerSlidePanelDom(): void {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}
registerSlidePanelDom();

export async function unregisterSlidePanelDom(): Promise<void> {
  if (GlobalRegistrator.isRegistered) {
    // Drain React callbacks before removing the globals they still read.
    await act(async () => {});
    await GlobalRegistrator.unregister();
  }
}
