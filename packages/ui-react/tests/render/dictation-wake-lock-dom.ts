// happy-dom registration for the dictation wake-lock render tests; each render
// test file registers and unregisters its own DOM in beforeAll/afterAll so
// `--rerun-each` repetitions re-register cleanly after afterAll unregisters.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

export function registerDictationWakeLockDom(): void {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register();
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

registerDictationWakeLockDom();

export async function unregisterDictationWakeLockDom(): Promise<void> {
  if (GlobalRegistrator.isRegistered) {
    await act(async () => {});
    await GlobalRegistrator.unregister();
  }
}
