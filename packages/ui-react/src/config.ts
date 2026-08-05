/**
 * Deployment-tunable branding/copy. A module-level singleton, matching the
 * renderer/ASR registries: the shell calls `configureBrainUi()` once at boot
 * (before mounting), components read `uiConfig` at render time. Runtime
 * plugin-style reconfiguration is deliberately unsupported.
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
}

export const uiConfig: BrainUiConfig = {
  appName: "Brain UI",
  assistantName: "Brain",
  shareTitle: "Shared from Brain",
  composerPlaceholder: "Ask your brain anything...",
};

export function configureBrainUi(overrides: Partial<BrainUiConfig>): void {
  Object.assign(uiConfig, overrides);
}
