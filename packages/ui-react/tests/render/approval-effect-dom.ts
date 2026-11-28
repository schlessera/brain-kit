// happy-dom registration for the approval-effect render tests, a sibling of
// `dom.ts` for the reason `slide-panel-dom.ts` gives: that module's body runs
// once per process, so a second test file importing it would get no DOM.
// Import it FIRST, before any component module.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { enterActEnvironment, restoreActEnvironment } from "../act-environment.js";
import { act } from "react";

if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register();
}
enterActEnvironment();

export async function unregisterApprovalEffectDom(): Promise<void> {
  try {
    if (GlobalRegistrator.isRegistered) {
      // Drain React callbacks before removing the globals they still read.
      await act(async () => {});
      await GlobalRegistrator.unregister();
    }
  } finally {
    restoreActEnvironment();
  }
}
