// happy-dom registration for the dictation wake-lock render tests; each render
// test file registers and unregisters its own DOM in afterAll. Import FIRST.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register();
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export async function unregisterDictationWakeLockDom(): Promise<void> {
  if (GlobalRegistrator.isRegistered) {
    await act(async () => {});
    await GlobalRegistrator.unregister();
  }
}
