// happy-dom registration for the block-card render tests; a sibling of
// `dom.ts` for the reason `ask-user-dom.ts` states: that module's body runs
// once per process, so each render test file registers its own DOM and
// unregisters it in `afterAll`. Import it FIRST, before any component module.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

export function registerBlockCardDom(): void {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register();
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

registerBlockCardDom();

export async function unregisterBlockCardDom(): Promise<void> {
  if (GlobalRegistrator.isRegistered) {
    await GlobalRegistrator.unregister();
  }
}
