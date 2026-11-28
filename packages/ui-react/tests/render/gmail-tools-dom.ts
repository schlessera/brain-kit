// happy-dom registration for the Gmail tool render tests; a sibling of
// `dom.ts` for the reason `ask-user-dom.ts` states: that module's body runs
// once per process, so each render test file registers its own DOM and
// unregisters it in `afterAll`. Import it FIRST, before any component module.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { enterActEnvironment, restoreActEnvironment } from "../act-environment.js";

export function registerGmailToolsDom(): void {
  if (!GlobalRegistrator.isRegistered) {
    // A real origin, as the app runs on one.
    GlobalRegistrator.register({ url: "http://localhost/" });
  }
  enterActEnvironment();
}

registerGmailToolsDom();

export async function unregisterGmailToolsDom(): Promise<void> {
  try {
    if (GlobalRegistrator.isRegistered) {
      await GlobalRegistrator.unregister();
    }
  } finally {
    restoreActEnvironment();
  }
}
