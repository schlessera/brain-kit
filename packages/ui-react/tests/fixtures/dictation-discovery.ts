// Dictation selection for tests about what happens after a take starts
// (#3709). A take resolves its service from the root's discovery snapshot and
// asks for the one-time acknowledgement before any session request; tests
// about capture, drain and teardown prime both, so start() requests its
// session as it did before selection existed.
import type { VoiceProvidersResponse } from "@schlessera/brain-ui-sdk/protocol";
import type { BrainUiRoot } from "../../src/root.js";
import { acknowledge } from "../../src/voice/dictation-providers.js";

const capabilities = { streaming: true, interimResults: true, keyterms: false, endpointing: false, savedAudio: false };

/** One registered provider, effective as the host default. */
export function singleProviderDiscovery(providerId: string): VoiceProvidersResponse {
  return {
    providers: [{ id: providerId, label: providerId, capabilities }],
    dictation: { saved: null, savedUsable: false, host: providerId, effective: providerId, source: "host", smart: true, revision: "0" },
  };
}

/** The root knows its dictation service and this device has acknowledged it. */
export function primeDictation(root: BrainUiRoot, providerId: string): VoiceProvidersResponse {
  const snapshot = singleProviderDiscovery(providerId);
  // Far enough ahead that a test's own clock never makes it stale.
  root.stores.voice.setState({ discovery: { snapshot, at: Date.now() + 24 * 60 * 60_000 } });
  acknowledge(root, snapshot.providers[0]!);
  return snapshot;
}

/** Deepgram as the effective dictation service, able (or not) to transcribe saved recordings. */
export function deepgramDiscovery(savedAudio = true): VoiceProvidersResponse {
  return {
    providers: [{ id: "deepgram", label: "Deepgram", capabilities: { ...capabilities, keyterms: true, endpointing: true, savedAudio } }],
    dictation: { saved: null, savedUsable: false, host: "deepgram", effective: "deepgram", source: "host", smart: true, revision: "0" },
  };
}
