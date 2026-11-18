// happy-dom registration for the streaming markdown render test (#2588); a
// sibling of `dom.ts` for the reason `ask-user-dom.ts` states: that module's
// body runs once per process, so each render test file registers its own DOM
// and unregisters it in `afterAll`. Import it FIRST, before any component.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

export function registerStreamingMarkdownDom(): void {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register({ url: "http://localhost/" });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

registerStreamingMarkdownDom();

export async function unregisterStreamingMarkdownDom(): Promise<void> {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
}
