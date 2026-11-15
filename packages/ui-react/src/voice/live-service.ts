// What a Start can use for its live-conversation service (#3616), derived
// from the conversation client's state. The Start card (#3698) draws its
// Service row, Change and the S3d pick from this; Settings › Voice draws the
// Live service group from the same roster. Nothing here opens a provider.

import type { ConversationProfile, LiveDefault, LiveProviderSource } from "@schlessera/brain-ui-sdk/protocol";
import type { ConversationClientState } from "./conversation-client.js";

interface LiveServiceView {
  /** Every usable (registered) service, in the host's order. Empty: live conversation isn't set up. */
  services: ConversationProfile[];
  /** The service explicit Start would disclose and open now; null when a pick is required. */
  selected: ConversationProfile | null;
  /**
   * Why `selected` is the one: `change` for this entry's one-time pick, else
   * the host's resolution. `legacy` for a host that sends no roster.
   */
  source: LiveProviderSource | "legacy";
  /** A saved default the host no longer registers (S3d); it stays saved until changed in Settings. */
  savedUnavailable: string | null;
  /** Start needs an explicit pick from `services` first (S3d, or several with no default). */
  pickRequired: boolean;
  /** Show Change: two or more usable services (L1). */
  canChange: boolean;
  /** The host's resolution, unchanged, for presentation; null on a legacy host. */
  liveDefault: LiveDefault | null;
}

type Source = Pick<ConversationClientState, "conversationProfile" | "conversationProfiles" | "liveDefault" | "serviceChoice">;

export function liveServiceView(s: Source): LiveServiceView {
  if (!s.liveDefault || s.conversationProfiles.length === 0) {
    return { services: s.conversationProfile ? [s.conversationProfile] : [], selected: s.conversationProfile, source: "legacy",
      savedUnavailable: null, pickRequired: false, canChange: false, liveDefault: null };
  }
  const services = s.conversationProfiles;
  const choice = s.serviceChoice !== null ? services.find((p) => p.providerId === s.serviceChoice) ?? null : null;
  const selected = s.conversationProfile;
  const savedUnavailable = s.liveDefault.saved !== null && !s.liveDefault.savedUsable ? s.liveDefault.saved : null;
  return {
    services,
    selected,
    source: choice && selected?.providerId === choice.providerId ? "change" : s.liveDefault.source,
    savedUnavailable,
    pickRequired: selected === null,
    canChange: services.length >= 2,
    liveDefault: s.liveDefault,
  };
}
