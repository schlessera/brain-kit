// Register before component imports, as the render smoke files do (../render/dom.ts explains why).
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/** Registers happy-dom; called at import and again by a repeated evaluation of the fixture. */
export function registerRunDetailTeardownDom(): void {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

registerRunDetailTeardownDom();

export async function unregisterRunDetailTeardownDom(): Promise<void> {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
}
