// happy-dom registration for the sixth-pass desktop-pane render tests, a sibling of
// `dom.ts` on purpose: that module's body runs once per process, so a second
// test file importing it after `render-smoke` has unregistered would get no
// DOM. This module is imported by `desktop-panes-sixth.test.tsx` alone, so its body runs
// exactly when that file loads, and the file's `afterAll` unregisters again
// before the next test file — the same containment contract, kept per file.
// Import it FIRST, before any component module.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register();
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export function unregisterDesktopPanesDom(): void {
  if (GlobalRegistrator.isRegistered) {
    void GlobalRegistrator.unregister();
  }
}
