// happy-dom registration for the turn journal's Google render tests (#4216),
// a sibling of `dom.ts` for the reason `github-tools-dom.ts` gives: that
// module's body runs once per process, so each render test file registers its
// own DOM and unregisters it in `afterAll`. Import it FIRST, before any
// component module, and call `registerTurnJournalGoogleDom()` at the top of
// the test file too: under `--rerun-each` the cached import does not register
// again after the previous pass unregistered.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

export function registerTurnJournalGoogleDom(): void {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register({ url: "http://localhost/" });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

registerTurnJournalGoogleDom();

export async function unregisterTurnJournalGoogleDom(): Promise<void> {
  if (GlobalRegistrator.isRegistered) {
    // Drain React callbacks before removing the globals they still read.
    await act(async () => {});
    await GlobalRegistrator.unregister();
  }
}
