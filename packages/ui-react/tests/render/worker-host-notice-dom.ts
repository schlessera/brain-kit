// happy-dom registration for the worker host notice render tests; a sibling of
// `dom.ts` for the reason `ask-user-dom.ts` states. Import it FIRST.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register();
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export async function unregisterWorkerHostNoticeDom(): Promise<void> {
  if (GlobalRegistrator.isRegistered) {
    // Drain React callbacks before removing the globals they still read.
    await act(async () => {});
    await GlobalRegistrator.unregister();
  }
}
