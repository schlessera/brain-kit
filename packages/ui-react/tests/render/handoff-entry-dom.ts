// happy-dom registration for the handoff entry render tests; a sibling of
// `dom.ts` for the reason `ask-user-dom.ts` states. Import it FIRST.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { enterActEnvironment, restoreActEnvironment } from "../act-environment.js";
import { act } from "react";

if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register();
}
enterActEnvironment();

export async function unregisterHandoffEntryDom(): Promise<void> {
  try {
    if (GlobalRegistrator.isRegistered) {
      // Drain React callbacks before removing the globals they still read.
      await act(async () => {});
      await GlobalRegistrator.unregister();
    }
  } finally {
    restoreActEnvironment();
  }
}
