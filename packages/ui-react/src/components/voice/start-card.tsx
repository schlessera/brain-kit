import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { StartCard, type StartCardNotice, type StartCardPersona } from "@schlessera/brain-ui-kit";
import {
  STANDARD_PERSONA_ID,
  STANDARD_PERSONA_REVISION,
  type ConversationProfile,
  type LivePersonaProviderStatus,
  type LivePersonaStatus,
  type LivePersonaSummary,
} from "@schlessera/brain-ui-sdk/protocol";
import { useBrainUiRoot } from "../../root-context.js";
import { ApiRequestError } from "../../lib/api-client.js";
import { conversationService } from "../../voice/conversation-client.js";
import { liveServiceView } from "../../voice/live-service.js";

const STANDARD: LivePersonaSummary = { id: STANDARD_PERSONA_ID, name: "Standard", voices: {}, instructionBytes: 0, revision: STANDARD_PERSONA_REVISION, builtIn: true };

/**
 * What one persona means for one service, exactly as the host computes it
 * (`providerStatus`, packages/ui-server/src/voice/personas.ts). Null: the
 * persona is invalid, or the service takes no personas.
 */
function personaOnService(persona: LivePersonaSummary, profile: ConversationProfile, live: LivePersonaStatus | null): LivePersonaProviderStatus | null {
  // The host's own answer for the saved persona wins whenever it is the same file.
  if (live && live.persona.id === persona.id && live.persona.revision === persona.revision) return live.providers[profile.providerId] ?? null;
  if (persona.invalid || !profile.voices || !profile.defaultVoice || profile.personaInstructionBytes === undefined) return null;
  const saved = persona.builtIn ? undefined : persona.voices[profile.providerId];
  const offered = saved !== undefined && profile.voices.some((voice) => voice.id === saved);
  return {
    voice: offered ? saved : profile.defaultVoice,
    voiceSource: offered ? "persona" : "default",
    ...(saved !== undefined && !offered ? { staleVoice: saved } : {}),
    maxInstructionBytes: profile.personaInstructionBytes,
    overLimit: persona.instructionBytes > profile.personaInstructionBytes,
  };
}

const voiceLabel = (profile: ConversationProfile, id: string) => profile.voices?.find((voice) => voice.id === id)?.label ?? id;
const count = (n: number) => n.toLocaleString("en-US");

/** The persona row's second line: the voice it speaks with on this service. */
function voiceLine(persona: LivePersonaSummary, profile: ConversationProfile | null, status: LivePersonaProviderStatus | null, defaultThisTime: boolean): string | undefined {
  if (!profile) return undefined;
  const service = conversationService(profile.providerId);
  if (persona.invalid) return "can’t be used";
  if (!status) return persona.builtIn ? undefined : `not available with ${service}`;
  if (status.staleVoice !== undefined) return defaultThisTime ? `default voice ${voiceLabel(profile, status.voice)} this time` : `voice ${status.staleVoice} · no longer offered`;
  if (status.voiceSource === "persona" || persona.builtIn) return `voice ${voiceLabel(profile, status.voice)}`;
  return `no ${service} voice set`;
}

/** The persona list and the saved selection's revision, read when the card opens. */
function usePersonas(open: boolean, live: LivePersonaStatus | null) {
  const root = useBrainUiRoot();
  const [list, setList] = useState<LivePersonaSummary[] | null>(null);
  const [saved, setSaved] = useState<{ value: string; revision: number } | null>(null);
  // A pushed change re-reads the files, as Settings › Voice does.
  useEffect(() => {
    if (!open || !live) return;
    let current = true;
    void Promise.all([root.api.livePersonas(), root.api.voiceSettings()]).then(([personas, settings]) => {
      if (!current) return;
      setList(personas.personas); setSaved(settings.persona);
    }, () => { if (current) setList(null); });
    return () => { current = false; };
  }, [root, open, live]);
  return { list, saved, setSaved };
}

/**
 * The Start card (#3698): the kit `StartCard` (#3692) fed with the real
 * service, persona and disclosure data. It replaces the pre-Start sheet and
 * shows everything that sheet showed. Nothing here starts a microphone,
 * reads history or opens a provider: Change and a persona pick only record
 * this entry's choice (and V2 saves the persona as the default); `Start` is
 * the only way out that opens anything.
 */
export function ConversationStartCard({ backend, onLeave }: { backend: string; onLeave: () => void }) {
  const root = useBrainUiRoot();
  const client = root.connection.conversation;
  const s = useStore(client.state);
  const chat = useStore(root.stores.connection, (state) => state.wsStatus);
  const { list, saved, setSaved } = usePersonas(s.disclosureOpen, s.livePersona);
  const frame = useRef<HTMLDivElement>(null);
  // The composer that opened Start is gone; focus moves to the card's Start.
  useEffect(() => { frame.current?.querySelector<HTMLElement>(".bk-voice-start")?.focus(); }, []);

  const leave = () => { client.leave(); onLeave(); };
  const live = liveServiceView(s);
  const disclosed = s.conversationProfile;
  const service = disclosed ? conversationService(disclosed.providerId) : null;
  const pickable = !s.profile && live.services.length > 0 && (live.canChange || live.pickRequired);
  const changeService = pickable ? () => {
    const ids = live.services.map((option) => option.providerId);
    const at = disclosed ? ids.indexOf(disclosed.providerId) : -1;
    client.chooseService(ids[(at + 1) % ids.length]!);
  } : undefined;

  // Personas: only on a host that resolves them (#3617).
  const status = s.livePersona;
  const known = list ?? (status ? [STANDARD, ...(status.persona.id === STANDARD_PERSONA_ID ? [] : [status.persona])] : []);
  const choice = s.personaChoice;
  const selectedId = choice?.id ?? status?.persona.id;
  const personas = status ? known.filter((persona) => !persona.invalid || persona.id === selectedId) : [];
  const selected = personas.find((persona) => persona.id === selectedId) ?? null;
  const defaultThisTime = choice?.voice === "default";
  const onService = (persona: LivePersonaSummary) => disclosed ? personaOnService(persona, disclosed, status) : null;
  const rows: StartCardPersona[] = personas.map((persona) => ({ id: persona.id, name: persona.name,
    voice: voiceLine(persona, disclosed, onService(persona), persona.id === selectedId && defaultThisTime) }));

  const pickPersona = async (id: string) => {
    const persona = personas.find((entry) => entry.id === id);
    if (!persona || (id === selectedId && !defaultThisTime)) return;
    client.choosePersona({ id: persona.id, revision: persona.revision });
    // V2: a pick on the card is also the saved default. The choice above makes
    // Start send this persona even while the save is on the way.
    if (!saved || saved.value === id) return;
    try {
      setSaved((await root.api.saveLivePersonaSelection(id, saved.revision)).persona);
    } catch (error) {
      if (!(error instanceof ApiRequestError && error.message === "LIVE_PERSONA_CHANGED")) return;
      // Changed on another device meanwhile: this pick is newer, so it is saved over it.
      try {
        const current = await root.api.voiceSettings();
        setSaved((await root.api.saveLivePersonaSelection(id, current.persona.revision)).persona);
      } catch { /* the one-time choice still stands for this Start */ }
    }
  };
  const standardThisTime = { label: "Use Standard this time", onClick: () => client.choosePersona({ id: STANDARD_PERSONA_ID, revision: STANDARD_PERSONA_REVISION }) };

  // One notice at a time: what blocks Start first, then what Start will do differently.
  const notice = ((): StartCardNotice | undefined => {
    if (!disclosed && !pickable) return { kind: "block", text: s.notice || "Connecting to the configured voice service…" };
    if (!disclosed) return { kind: "block", text: live.savedUnavailable
      ? `Your saved service, ${conversationService(live.savedUnavailable)}, isn’t available here. Choose a service to start.`
      : "Choose a service to start." };
    if (chat !== "connected") return { kind: "block", text: "Waiting for the connection to this app’s host. Start works once it’s back." };
    if (!selected || !service) return s.notice ? { kind: "warn", text: s.notice } : undefined;
    const st = onService(selected);
    if (selected.invalid) return { kind: "block", text: `${selected.name} can’t be used. Edit it in Settings › Voice, or use Standard this time.`, action: standardThisTime };
    if (!st && !selected.builtIn) return { kind: "block", text: `${service} doesn’t take personas. Use Standard this time, or change the service.`, action: standardThisTime };
    if (st?.overLimit) return { kind: "block", text: `${selected.name}’s instructions are ${count(selected.instructionBytes)} bytes; ${service} takes ${count(st.maxInstructionBytes)}. Shorten them or change the service.`,
      action: { label: "Edit persona", onClick: () => root.stores.ui.getState().openSettings("voice") } };
    if (st?.staleVoice !== undefined && !defaultThisTime) return { kind: "error", text: `${selected.name}’s saved voice, ${st.staleVoice}, is no longer offered by ${service}. Use the default voice this time, or edit the persona.`,
      action: { label: "Use the default voice this time", onClick: () => client.choosePersona({ id: selected.id, revision: selected.revision, voice: "default" }) } };
    const warn = st?.staleVoice !== undefined ? `${selected.name}’s saved voice, ${st.staleVoice}, isn’t offered by ${service}. The default voice (${voiceLabel(disclosed, st.voice)}) is used this time.`
      : st && st.voiceSource === "default" && !selected.builtIn ? `${selected.name} has no ${service} voice. The default voice (${voiceLabel(disclosed, st.voice)}) is used this time.`
      : status?.selectedMissing && !choice && selected.id === STANDARD_PERSONA_ID ? `${status.selected} isn’t available — using Standard.`
      : "";
    const text = [s.notice, warn].filter(Boolean).join(" ");
    return text ? { kind: "warn", text } : undefined;
  })();

  // Everything the pre-Start sheet said, behind "What's shared".
  const profile = s.profile;
  const coverage = s.connection === "Connected" ? profile?.historyCoverage : undefined;
  const relay = typeof window === "undefined" ? root.apiBase() || "this application’s host" : new URL(root.apiBase() || "/", window.location.href).origin;
  const shared = [
    disclosed?.disclosure.voiceService ?? (pickable ? "No live service chosen yet." : "Connecting to the configured voice service…"),
    ...(disclosed?.disclosure.destinations ?? []),
    `Host relay: ${relay}`,
    `Independently selected agent backend: ${backend}. API destination and retention: unknown unless documented by the host.`,
    disclosed?.capabilities.contextualTasks === "supported"
      ? "Brain can start permitted background tasks from the conversation and share results while you keep talking. Actions that need confirmation use the same screen cards as typed requests. Recognition may be uncertain; speech cannot approve an action."
      : disclosed?.capabilities.finalTranscript !== "supported" ? "Automatic tasks aren't available with this service. Review recognized text and use Send now." : "",
    s.durableAvailable || client.historyOwnerFor(s.sessionId ?? "")
      ? "Recognized speech and generated voice replies are saved as text with this chat. This feature does not save audio. Reopening text does not replay audio or prove the voice service received this history."
      : "Live recognition is temporary and may be unavailable after reload.",
    "Starting voice sends bounded prior chat text and completed results to this voice service, including when you switch services. Raw audio is not retained by this feature.",
    coverage ? [coverage.state === "complete" ? "Available prior text was included in startup context." : coverage.state === "bounded" ? "Some prior text was omitted to fit startup context." : coverage.state === "partial" ? "Some prior discussion evidence or its original order is unavailable." : "Prior discussion evidence is unavailable.",
      coverage.tailOmitted ? (coverage.state === "partial" ? "The newest prior item may be missing." : "The newest prior item was not included.") : "",
      "This does not prove the service understood or recalled it."].filter(Boolean).join(" ") : "",
    "Spoken refusal is unavailable with the current voice services. Use Deny on screen.",
    profile?.capabilities.exactPermissionSpeech !== "supported" ? "Permission decisions remain on screen; spoken announcements are unavailable." : "",
  ].filter(Boolean);

  // "What's shared" carries the whole former sheet; opened on a small phone it
  // scrolls inside the card's frame instead of running off the screen.
  return <div ref={frame} data-start-card="" data-start-service={disclosed?.providerId ?? ""} data-start-persona={selected?.id ?? ""}
    style={{ maxHeight: "calc(100dvh - 16px)", overflowY: "auto", overscrollBehavior: "contain" }}
    onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); leave(); } }}>
    <StartCard
      service={service}
      showService={pickable}
      onChangeService={changeService}
      personas={rows}
      selectedPersona={selected?.id}
      onSelectPersona={(id) => void pickPersona(id)}
      notice={notice}
      shared={shared}
      onStart={client.start}
      onCancel={leave}
    />
  </div>;
}
