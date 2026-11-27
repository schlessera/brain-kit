// happy-dom registration for the approval-effect render tests, a sibling of
// `dom.ts` for the reason `slide-panel-dom.ts` gives: that module's body runs
// once per process, so a second test file importing it would get no DOM.
// Import it FIRST, before any component module.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

/** Registers happy-dom; runs on import, and again when a repeated evaluation of the test file calls it (./dom.ts, point 3). */
export function registerApprovalEffectDom(): void {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register();
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

registerApprovalEffectDom();

export async function unregisterApprovalEffectDom(): Promise<void> {
  if (GlobalRegistrator.isRegistered) {
    // Drain React callbacks before removing the globals they still read.
    await act(async () => {});
    await GlobalRegistrator.unregister();
  }
}
