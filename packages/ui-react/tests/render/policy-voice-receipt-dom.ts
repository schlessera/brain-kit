// happy-dom registration for the policy voice-receipt render test, a sibling of
// `dom.ts` for the reason `slide-panel-dom.ts` states: that module's body
// runs once per process, so each render test file registers its own DOM and
// unregisters it in `afterAll`. Import it FIRST, before any component module.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

const ACT_ENVIRONMENT = "IS_REACT_ACT_ENVIRONMENT";
let actEnvironment: PropertyDescriptor | undefined;
let registered = false;
/** Whether this fixture created the DOM, and so may remove it. */
let ownsDom = false;

/**
 * Register the DOM and React's act environment. The module body does it
 * once, for the component imports that follow; a repeated run of the file
 * (`--rerun-each`, the determinism job) reuses the loaded modules, so the
 * file registers again before its tests through this.
 */
export function registerPolicyVoiceDom(): void {
  if (!GlobalRegistrator.isRegistered) { GlobalRegistrator.register(); ownsDom = true; }
  if (!registered) {
    actEnvironment = Object.getOwnPropertyDescriptor(globalThis, ACT_ENVIRONMENT);
    registered = true;
  }
  Object.defineProperty(globalThis, ACT_ENVIRONMENT, { configurable: true, enumerable: true, writable: true, value: true });
}
registerPolicyVoiceDom();

/** Remove the DOM this fixture created and restore the act environment's exact descriptor. */
export async function unregisterPolicyVoiceDom(): Promise<void> {
  if (ownsDom && GlobalRegistrator.isRegistered) {
    // Drain React callbacks before removing the globals they still read.
    await act(async () => {});
    await GlobalRegistrator.unregister();
    ownsDom = false;
  }
  if (registered) {
    if (actEnvironment) Object.defineProperty(globalThis, ACT_ENVIRONMENT, actEnvironment);
    else delete (globalThis as Record<string, unknown>)[ACT_ENVIRONMENT];
    registered = false;
  }
}
