// happy-dom registration for the approval-effect render tests, a sibling of
// `dom.ts` for the reason `slide-panel-dom.ts` gives: that module's body runs
// once per process, so a second test file importing it would get no DOM.
// Import it FIRST, before any component module.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register();
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export function unregisterApprovalEffectDom(): void {
  if (GlobalRegistrator.isRegistered) {
    void GlobalRegistrator.unregister();
  }
}
