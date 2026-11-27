// Register before component imports; contain globals like the other render suites.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/** Registers happy-dom; called at import and again by a repeated evaluation of the test file. */
export function registerSmokeActivityGraphDom(): void {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

registerSmokeActivityGraphDom();

export async function unregisterSmokeActivityGraphDom(): Promise<void> {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
}
