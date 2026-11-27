// happy-dom registration for the socket-open render tests; a sibling of
// `dom.ts` for the reason `ask-user-dom.ts` states: that module's body runs
// once per process, so each render test file registers its own DOM and
// unregisters it in `afterAll`. Import it FIRST, before any component module.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

/** Registers the DOM; a repeated evaluation of the test file calls it again, after the last one's unregistration. */
export function registerSocketOpensDom(): void {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register();
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

registerSocketOpensDom();

export async function unregisterSocketOpensDom(): Promise<void> {
  if (GlobalRegistrator.isRegistered) {
    // Drain React callbacks before removing the globals they still read.
    await act(async () => {});
    await GlobalRegistrator.unregister();
  }
}
