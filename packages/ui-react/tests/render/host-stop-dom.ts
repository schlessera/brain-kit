// happy-dom registration for the host-stop render test, a sibling of
// `dom.ts` for the reason `slide-panel-dom.ts` states: that module's body
// runs once per process, so each render test file registers its own DOM and
// unregisters it in `afterAll`. Import it FIRST, before any component module.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

const ACT_ENVIRONMENT = "IS_REACT_ACT_ENVIRONMENT";
let actEnvironment: PropertyDescriptor | undefined;
let registered = false;

/**
 * Register the DOM and React's act environment. The module body does it
 * once, for the component imports that follow; a repeated run of the file
 * (`--rerun-each`, the determinism job) reuses the loaded modules, so the
 * file registers again before its tests through this.
 */
export function registerHostStopDom(): void {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
  if (!registered) {
    actEnvironment = Object.getOwnPropertyDescriptor(globalThis, ACT_ENVIRONMENT);
    registered = true;
  }
  Object.defineProperty(globalThis, ACT_ENVIRONMENT, { configurable: true, enumerable: true, writable: true, value: true });
}
registerHostStopDom();

/** Remove the DOM and restore the act environment's exact descriptor. */
export async function unregisterHostStopDom(): Promise<void> {
  if (GlobalRegistrator.isRegistered) {
    // Drain React callbacks before removing the globals they still read.
    await act(async () => {});
    await GlobalRegistrator.unregister();
  }
  if (registered) {
    if (actEnvironment) Object.defineProperty(globalThis, ACT_ENVIRONMENT, actEnvironment);
    else delete (globalThis as Record<string, unknown>)[ACT_ENVIRONMENT];
    registered = false;
  }
}
