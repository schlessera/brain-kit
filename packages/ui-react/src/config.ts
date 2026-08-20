/**
 * The package's single configuration chokepoint.
 *
 * `ui-server` resolves its configuration once, at the edge, in `createApp()`,
 * and nothing deeper in that package touches the ambient environment. This is
 * the browser-side mirror of that rule: the deployment shell calls
 * `configureBrainUi()` once at boot, before the first render, and every module
 * below reads the resolved values instead of reaching for build-tool globals.
 *
 * The rule exists because a library that reads `import.meta.env` pins its
 * consumers to one bundler. `VITE_BACKEND_URL` used to be read here at module
 * load, so a webpack or Next.js consumer had no way to point the client at a
 * split-topology backend at all, and no way to discover that from the types.
 * `scripts/check-env-access.ts` now refuses `import.meta.env` anywhere in a
 * package's `src`, so the loophole cannot reopen.
 *
 * Values are a module-level singleton, matching the renderer/ASR registries.
 * Runtime plugin-style reconfiguration is deliberately unsupported.
 */
export interface BrainUiConfig {
  /** Product name shown on the login screen and connection status. */
  appName: string;
  /** Name the assistant speaks as in the transcript. */
  assistantName: string;
  /** Default title for shared artifacts (share cards, rendered PNG/PDF). */
  shareTitle: string;
  /** Composer placeholder. */
  composerPlaceholder: string;
  /**
   * Origin of the API/WebSocket backend, for a SPLIT topology (client and
   * backend on different origins, e.g. a public frontend reaching its backend
   * over a VPN). Empty — the default — means SAME-ORIGIN: API calls go to
   * `/api` and the WebSocket derives its host from `window.location`.
   *
   * The shell resolves this however it likes (a Vite `VITE_*` define, a
   * `<meta>` tag, a runtime fetch) and passes the result in. A trailing slash
   * is stripped.
   */
  backendUrl: string;
  /**
   * Install the `window.__chatStore` / `window.__graphStore` debug handles,
   * which let browser automation inject fixture messages without a live agent
   * session. The shell decides what "development" means — this package must
   * not infer it from a bundler's DEV flag.
   */
  devTools: boolean;
}

export const uiConfig: BrainUiConfig = {
  appName: "Brain UI",
  assistantName: "Brain",
  shareTitle: "Shared from Brain",
  composerPlaceholder: "Ask your brain anything...",
  backendUrl: "",
  devTools: false,
};

/**
 * Dev-handle installers, registered at module scope by the stores that own a
 * handle. They cannot read `uiConfig.devTools` themselves: ES imports are
 * hoisted, so a store's module body runs BEFORE the shell's
 * `configureBrainUi()` call. Registering instead of reading lets the flag
 * arrive late and still take effect.
 */
const devHandleInstallers: Array<() => void> = [];
let devHandlesInstalled = false;

function installDevHandles(): void {
  if (devHandlesInstalled) return;
  devHandlesInstalled = true;
  for (const install of devHandleInstallers) install();
}

/** Register a debug handle to install if (and when) `devTools` is turned on. */
export function registerDevHandle(install: () => void): void {
  devHandleInstallers.push(install);
  if (uiConfig.devTools) install();
}

export function configureBrainUi(overrides: Partial<BrainUiConfig>): void {
  Object.assign(uiConfig, overrides);
  if (typeof overrides.backendUrl === "string") {
    uiConfig.backendUrl = overrides.backendUrl.replace(/\/$/, "");
  }
  if (uiConfig.devTools) installDevHandles();
}
