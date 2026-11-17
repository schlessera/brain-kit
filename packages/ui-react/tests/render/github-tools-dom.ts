// happy-dom registration for the GitHub tool render tests; a sibling of
// `dom.ts` for the reason `ask-user-dom.ts` states: that module's body runs
// once per process, so each render test file registers its own DOM and
// unregisters it in `afterAll`. Import it FIRST, before any component module.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

export function registerGithubToolsDom(): void {
  if (!GlobalRegistrator.isRegistered) {
    // A real origin, so the kit's same-origin avatar check can pass (#3795).
    GlobalRegistrator.register({ url: "http://localhost/" });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

registerGithubToolsDom();

export async function unregisterGithubToolsDom(): Promise<void> {
  if (GlobalRegistrator.isRegistered) {
    await GlobalRegistrator.unregister();
  }
}
