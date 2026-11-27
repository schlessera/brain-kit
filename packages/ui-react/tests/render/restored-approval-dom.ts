// happy-dom registration for the restored-approval render test; a sibling of
// `dom.ts` for the reason `ask-user-dom.ts` states: that module's body runs
// once per process, so each render test file registers its own DOM and
// unregisters it in `afterAll`. Import it FIRST, before any component module.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

/**
 * Register the DOM. The module body does it once, for the component imports
 * that follow; a repeated run of the file (`--rerun-each`, the determinism
 * job) reuses the loaded modules, so the file registers again before its
 * tests through this.
 */
export function registerRestoredApprovalDom(): void {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register();
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}
registerRestoredApprovalDom();

export async function unregisterRestoredApprovalDom(): Promise<void> {
  if (GlobalRegistrator.isRegistered) {
    // Drain React callbacks before removing the globals they still read.
    await act(async () => {});
    await GlobalRegistrator.unregister();
  }
}
