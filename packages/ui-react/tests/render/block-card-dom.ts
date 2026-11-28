// happy-dom registration for the block-card render tests; a sibling of
// `dom.ts` for the reason `ask-user-dom.ts` states: that module's body runs
// once per process, so each render test file registers its own DOM and
// unregisters it in `afterAll`. Import it FIRST, before any component module.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { enterActEnvironment, restoreActEnvironment } from "../act-environment.js";

export function registerBlockCardDom(): void {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register();
  }
  enterActEnvironment();
}

registerBlockCardDom();

export async function unregisterBlockCardDom(): Promise<void> {
  try {
    if (GlobalRegistrator.isRegistered) {
      await GlobalRegistrator.unregister();
    }
  } finally {
    restoreActEnvironment();
  }
}
