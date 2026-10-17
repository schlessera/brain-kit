// Register before component imports; contain globals like the other render suites.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export async function unregisterDurableActionsDom(): Promise<void> {
  if (GlobalRegistrator.isRegistered) {
    await act(async () => {});
    await GlobalRegistrator.unregister();
  }
}
