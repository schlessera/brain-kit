// happy-dom registration for the image markup render test, a sibling of
// `ask-user-dom.ts` on purpose: a registration module's body runs once per
// process, so a second test file sharing one gets no DOM when an earlier file
// in the same worker has already unregistered it. This module is imported by
// `image-markup.test.tsx` alone, so its body runs exactly when that file
// loads, and the file's `afterAll` unregisters again before the next file.
// Import it FIRST, before any component module.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register();
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export async function unregisterImageMarkupDom(): Promise<void> {
  if (GlobalRegistrator.isRegistered) {
    // Drain React callbacks before removing the globals they still read.
    await act(async () => {});
    await GlobalRegistrator.unregister();
  }
}
