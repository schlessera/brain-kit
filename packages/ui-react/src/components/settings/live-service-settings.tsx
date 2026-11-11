import { useEffect } from "react";
import { useStore } from "zustand";
import { LiveServiceSettings, type LiveServiceOption, type LiveServiceStatus } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot, useRootStore } from "../../root-context.js";
import { conversationService } from "../../voice/conversation-client.js";
import { liveSettingsStore, loadLiveSettings, saveLiveDefault } from "../../voice/live-settings-save.js";

/**
 * The Live service group of Settings › Voice (#3616): the brain-wide default
 * live-conversation service, saved the moment one is picked. The registered
 * services come from the connection's hello; the saved value and its
 * revision from `GET /api/settings/voice`. It is independent of Dictation and
 * of the ordinary model default. Opening or saving it opens no provider, no
 * microphone and reads no history; a save applies from the next Start and a
 * running conversation keeps its service.
 */
export function LiveServiceGroup({ active }: { active: boolean }) {
  const root = useBrainUiRoot();
  const client = root.connection.conversation;
  const profiles = useStore(client.state, (s) => s.conversationProfiles);
  const legacy = useStore(client.state, (s) => s.liveDefault ? null : s.conversationProfile);
  const liveDefault = useStore(client.state, (s) => s.liveDefault);
  const inUse = useStore(client.state, (s) => s.active && s.profile ? s.profile.providerId : null);
  const connected = useRootStore("connection", (s) => s.wsStatus === "connected");
  const store = liveSettingsStore(root);
  const live = useStore(store);

  useEffect(() => {
    // Opening Settings reads the saved value; it writes nothing.
    if (active) void loadLiveSettings(root);
  }, [active, root]);
  // Another device saved: read the new revision, unless a pick is on its way.
  const remoteSaved = liveDefault?.saved;
  useEffect(() => {
    if (!active || live.pending !== undefined || !live.settings || remoteSaved === undefined || remoteSaved === live.settings.defaultProvider) return;
    void loadLiveSettings(root);
  }, [active, root, remoteSaved, live.pending, live.settings]);

  const roster = profiles.length ? profiles : legacy ? [legacy] : [];
  const services: LiveServiceOption[] = roster.map((p) => ({ id: p.providerId, name: conversationService(p.providerId), detail: p.disclosure.voiceService }));
  const saved = live.pending !== undefined ? live.pending : live.settings ? live.settings.defaultProvider : liveDefault?.saved ?? null;
  const usable = (id: string | null) => id !== null && services.some((s) => s.id === id);
  const hostDefault = liveDefault?.source === "host" ? liveDefault.effective : null;
  const checked = saved !== null ? (usable(saved) ? saved : null) : hostDefault ?? (services.length === 1 ? services[0]!.id : null);
  const savedUnavailable = saved !== null && !usable(saved) ? { id: saved, name: conversationService(saved) } : null;
  const status: LiveServiceStatus | null = live.status?.kind === "failed" ? { kind: "failed", text: live.status.text } : live.status;
  const retry = live.status?.kind === "failed" ? live.status.retry : undefined;

  return <div data-live-service-group="">
    <LiveServiceSettings
      services={services}
      checked={checked}
      saved={saved}
      hostDefault={hostDefault}
      inUse={inUse}
      savedUnavailable={savedUnavailable}
      status={status}
      readOnly={live.load === "forbidden"}
      disabled={live.load !== "loaded"}
      loading={!connected || (live.load === "loading" && !live.settings)}
      loadError={live.load === "failed"}
      onChoose={(id) => { if (live.load === "loaded") void saveLiveDefault(root, id); }}
      onRetry={() => { if (retry !== undefined) void saveLiveDefault(root, retry); }}
      onReload={() => void loadLiveSettings(root)}
    />
  </div>;
}
