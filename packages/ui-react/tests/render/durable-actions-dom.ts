// Register before component imports; contain globals like the other render suites.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { enterActEnvironment, restoreActEnvironment } from "../act-environment.js";
import { act } from "react";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
enterActEnvironment();

export async function unregisterDurableActionsDom(): Promise<void> {
  try {
    if (GlobalRegistrator.isRegistered) {
      await act(async () => {});
      await GlobalRegistrator.unregister();
    }
  } finally {
    restoreActEnvironment();
  }
}
