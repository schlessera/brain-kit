/**
 * Where a "Why" link from an Apify refusal or cost line should land in
 * Settings › Accounts › Apify. One pending request per UI root; the section
 * takes it once, after its facts load, so a stale request never moves focus
 * on a later visit.
 */
import type { BrainUiRoot } from "../root.js";

type ApifySettingsTarget = "provider" | "discovery" | "actors" | "grants" | "limits" | "today";

const requests = new WeakMap<BrainUiRoot, ApifySettingsTarget>();

/** Open Settings › Accounts and ask the Apify section to focus `target`. */
export function openApifySettings(root: BrainUiRoot, target: ApifySettingsTarget): void {
  requests.set(root, target);
  root.stores.ui.getState().openSettings("accounts");
}

export function pendingApifyFocus(root: BrainUiRoot): ApifySettingsTarget | undefined {
  return requests.get(root);
}

export function takeApifyFocus(root: BrainUiRoot): ApifySettingsTarget | undefined {
  const target = requests.get(root);
  requests.delete(root);
  return target;
}
