import { DraftSaveLine } from "../chat/draft-save-line.js";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { Button, Disclosure, Overlay, TextButton, VoiceControlButton, VoiceField, VoiceNotice, type IconName } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot } from "../../root-context.js";
import { conversationService, type ConversationClientState } from "../../voice/conversation-client.js";

/** The live states the tall voice field draws (#3690); S5 is the Start sequence's Connecting. */
type LiveFieldState = "S5" | "L1" | "L2" | "L3" | "L4" | "L5" | "L6" | "L7" | "L8" | "L9";

/**
 * Maps the client's own state onto one live state. Every input is something
 * the client knows: its connection, capture intent, the playing reply, host
 * work and a pending approval card. `null` draws no field (before Start, or
 * while the disclosure sheet asks for one).
 */
function liveFieldState(s: Pick<ConversationClientState, "active" | "disclosureOpen" | "capture" | "connection" | "micOn" | "interaction" | "outputRecovery">,
  o: { speaking: boolean; hostWork: boolean; approval: boolean }): LiveFieldState | null {
  if (!s.active || s.capture === "idle" || s.disclosureOpen && s.capture === "stopped") return null;
  if (s.capture === "stopped") return "L9";
  if (s.connection === "Connecting") return "S5";
  if (s.connection !== "Connected") return "L8";
  // V5: a muted microphone does not silence brain's current sentence.
  if (o.speaking) return "L4";
  if (o.approval) return "L6";
  if (s.capture === "muted") return "L7";
  if (!s.micOn) return "S5";
  if (s.interaction === "Working" || s.interaction === "Answering question") return o.hostWork ? "L3" : "L2";
  if (s.outputRecovery === "speaking" || s.outputRecovery === "checking" || s.interaction === "Checking whether the reply stopped") return "L5";
  return "L1";
}

type Look = { tone: "you" | "brain" | "idle"; icon: IconName; word: string; meter: "level" | "sweep" | "flat" | "hatch" | "none"; spin?: boolean; outline?: boolean };
const LOOKS: Record<Exclude<LiveFieldState, "L9">, Look> = {
  S5: { tone: "brain", icon: "loading", word: "Connecting", meter: "none", spin: true },
  L1: { tone: "you", icon: "mic", word: "Listening", meter: "level" },
  L2: { tone: "brain", icon: "loading", word: "Thinking", meter: "sweep", spin: true },
  L3: { tone: "brain", icon: "working", word: "Working", meter: "sweep" },
  L4: { tone: "brain", icon: "speaker", word: "Speaking", meter: "level" },
  L5: { tone: "you", icon: "mic", word: "Listening", meter: "level" },
  L6: { tone: "idle", icon: "hand", word: "Needs your tap", meter: "none", outline: true },
  L7: { tone: "idle", icon: "mic-off", word: "Muted", meter: "flat" },
  L8: { tone: "idle", icon: "loading", word: "Reconnecting…", meter: "hatch" },
};

function clock(seconds: number) {
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60) % 60, sec = seconds % 60;
  return `${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(sec).padStart(2, "0")}`;
}

/** Seconds spent connected in this entry. The clock holds while reconnecting (L8). */
function useConnectedSeconds(running: boolean) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) return;
    const tick = setInterval(() => setSeconds(n => n + 1), 1000);
    return () => clearInterval(tick);
  }, [running]);
  return seconds;
}

/** The meter's reading, sampled only while a level meter shows. */
function useLevel(read: (() => number) | null) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!read) { setLevel(0); return; }
    const sample = setInterval(() => setLevel(Math.round(read() * 20) / 20), 80);
    return () => clearInterval(sample);
  }, [read]);
  return level;
}

/** The live conversation surface: the tall voice field, with the review and recovery controls above it. */
export function ConversationField({ backend, onLeave }: { backend: string; onLeave: () => void }) {
  const root = useBrainUiRoot();
  const client = root.connection.conversation;
  const s = useStore(client.state);
  const permission = useStore(client.permissions.state);
  const chat = useStore(root.stores.connection, (state) => state.wsStatus);
  const needsScreen = useStore(root.stores.chat, (state) => {
    const exchange = (s.sessionId === null ? state.draft : state.buffers[s.sessionId])?.askUser;
    return !!exchange && !exchange.cancelled && !exchange.answers && !exchange.order && !exchange.formAnswers && (exchange.questions.length !== 1 || !!exchange.list || !!exchange.rank || !!exchange.form);
  });
  const streaming = useStore(root.stores.chat, (state) => !!(s.sessionId === null ? state.draft : state.buffers[s.sessionId])?.isStreaming);
  // A pending approval is the tool card's to answer, by tap only (L6).
  const approval = useStore(root.stores.chat, (state) => !!(s.sessionId === null ? state.draft : state.buffers[s.sessionId])?.messages.some(m => m.toolCalls.some(t => t.status === "pending_approval")));
  // This hold is presentation only: PCM capture and interruption use the
  // client's instantaneous playing state, never this display state.
  const [replyToken, setReplyToken] = useState<number | null>(null);
  const canShowReply = s.active && s.connection === "Connected" && s.outputRecovery === "audible" && !s.disclosureOpen && s.interaction !== "Checking whether the reply stopped";
  const replyVisible = canShowReply && (s.playing || replyToken === s.token);
  useEffect(() => {
    if (!canShowReply) { setReplyToken(null); return; }
    if (s.playing) { setReplyToken(s.token); return; }
    const timeout = setTimeout(() => setReplyToken(null), 300);
    return () => clearTimeout(timeout);
  }, [canShowReply, s.playing, s.token]);
  const hostWork = streaming || Object.values(s.work).some((work) => work.state === "queued" || work.state === "running");
  const state = liveFieldState(s, { speaking: replyVisible, hostWork, approval });
  const seconds = useConnectedSeconds(s.connection === "Connected" && (s.capture === "listening" || s.capture === "muted"));
  const meter = state && state !== "L9" ? LOOKS[state].meter : "none";
  const [readInput] = useState(() => () => client.levels().input);
  const [readOutput] = useState(() => () => client.levels().output);
  const level = useLevel(meter !== "level" ? null : state === "L4" ? readOutput : readInput);
  const frame = useRef<HTMLDivElement>(null);
  const wasOn = useRef(false);
  useEffect(() => {
    if (s.micOn && !wasOn.current) frame.current?.querySelector<HTMLElement>('[aria-label="Mute"]')?.focus();
    wasOn.current = s.micOn;
  }, [s.micOn]);
  // Root-owned leases distinguish a true unmount from StrictMode or same-task
  // remounts. Component cleanup must never impersonate a manual Mute.
  useEffect(() => client.attachControls(), [client]);
  if (!s.active) return null;
  const profile = s.profile;
  const disclosed = s.conversationProfile;
  const coverage = s.connection === "Connected" ? profile?.historyCoverage : undefined;
  const button = { minHeight: 44, minWidth: 44, flex: "1 1 0", width: "auto", padding: "0 6px", fontSize: 12 };
  const leave = () => { client.leave(); onLeave(); };
  const contextual = Object.values(s.work).filter(w => w.provenance === "contextual");
  const service = profile ? conversationService(profile.providerId) : disclosed ? conversationService(disclosed.providerId) : null;
  const muted = s.capture === "muted";
  return <div ref={frame} data-conversation-field="" data-live-state={state ?? undefined} className="mx-auto max-w-3xl bg-background text-foreground" style={{ overflowWrap: "anywhere", maxHeight: "60dvh", overflowY: "auto" }}>
    <div className="sr-only" aria-live="polite" aria-atomic="true">{s.announcement}</div>
    {coverage && coverage.state !== "complete" && <div className="text-xs" role="status">{coverage.tailOmitted ? coverage.state === "partial" ? "Newest prior context may be missing." : "Newest prior context was not sent." : "Prior context is incomplete."} <TextButton label="Details" ariaLabel="Prior context details" inline onClick={client.details} /></div>}
    {s.outputRecovery === "muted" && <Button label="Recover reply audio" tone="ghost" style={button} onClick={client.recoverOutput} />}
    {s.notice && state !== "L9" && <div role="status" aria-label="Voice notice" style={{ fontSize: 12, lineHeight: 1.3 }}>{s.notice}</div>}
    {s.text && <div className="min-[900px]:flex min-[900px]:items-center min-[900px]:gap-3">
      <div style={{ height: 64, overflowY: "auto", fontSize: 12, flex: "1 1 0", minWidth: 0 }} data-conversation-review="" tabIndex={0} role="region" aria-label="Unsent voice transcript" className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--bk-focus-ring)]">
        <div className="font-mono text-[10px]">VOICE DRAFT · NOT SUBMITTED AS A BRAIN TASK</div>
        {s.voiceDraft && <DraftSaveLine draftId={s.voiceDraft.id} />}
        <div>{s.text}</div>
        <div>The voice service already received audio. A voice reply does not submit this draft.</div>
        <div>{needsScreen ? "This question needs the screen" : s.interaction === "Sending soon" ? "Sending soon" : "Review before sending"}</div>
      </div>
      <div className="w-full min-[900px]:w-[220px]" style={{ minHeight: 46, display: "flex", gap: 4 }}>
        <Button label="Send now" tone="primary" style={button} onClick={() => client.commit(s.token)} disabled={s.connection !== "Connected" || s.interaction === "Checking whether the reply stopped"} />
        <Button label="Discard" tone="ghost" style={button} onClick={client.discard} />
      </div>
    </div>}
    {contextual.length > 0 && <section aria-label="Conversation tasks" data-evidence-disclosure="" className="py-2 text-xs">
      <Disclosure icon="steps" label={`Background tasks · ${contextual.length} contextual ${contextual.length === 1 ? "request" : "requests"}`}>
      <ul>{contextual.slice(-8).map(w => <li key={w.requestId} className="py-1">
        <p>Context: {w.recognized.slice(-160)}</p>
        Conversation task · {w.state} · {w.delivery === "returned" ? "result accepted by voice service; playback unknown" : w.delivery === "unknown" ? "result acceptance unknown; no automatic replay" : w.delivery === "pending" ? "result pending" : "result withheld"}
        {w.reason && <p>{w.reason}</p>}
      </li>)}</ul>
      </Disclosure>
    </section>}
    {permission.line && <div data-voice-refusal-window="" className="text-destructive" style={{ minHeight: 40, fontSize: 12 }}>{permission.line}</div>}
    {state === "L9"
      ? <div className="pb-2"><VoiceNotice tone="fail" icon="attention" title="Live conversation stopped" body={s.notice || undefined}
          actions={[{ label: "Close", onClick: leave }, { label: "Start again", tone: "brain", onClick: client.details }]} /></div>
      : state && <div className="sticky bottom-0 bg-background pb-2">
        <VoiceField shape="tall" name="Live conversation" tone={LOOKS[state].tone} outline={LOOKS[state].outline}
          label={{ icon: LOOKS[state].icon, word: LOOKS[state].word, spin: LOOKS[state].spin, meta: [service, state === "S5" ? null : clock(seconds)].filter(Boolean).join(" · ") || undefined }}
          meter={meter} level={meter === "level" ? level : undefined}
          controls={<>
            <VoiceControlButton name={muted ? "Unmute" : "Mute"} icon={muted ? "mic-off" : "mic"} pressed={muted} disabled={state === "S5"} onClick={muted ? client.resume : client.mute} />
            <VoiceControlButton name="Interrupt" icon="interrupt" disabled={state !== "L4"} onClick={client.stopReply} />
            <VoiceControlButton name="End" icon="dismiss" tone="end" onClick={leave} />
          </>} />
      </div>}
    <Overlay open={s.disclosureOpen} variant="sheet" title="Live conversation" onClose={leave} data-overlay-site="conversation-disclosure">
      <div className="space-y-3 p-4 text-sm">
        <p>{disclosed?.disclosure.voiceService ?? "Connecting to the configured voice service…"}</p>
        {disclosed?.disclosure.destinations.map((destination) => <p key={destination}>{destination}</p>)}
        <p>Host relay: {typeof window === "undefined" ? root.apiBase() || "this application’s host" : new URL(root.apiBase() || "/", window.location.href).origin}</p>
        <p>Independently selected agent backend: {backend}. API destination and retention: unknown unless documented by the host.</p>
        {disclosed?.capabilities.contextualTasks === "supported"
          ? <p>Brain can start permitted background tasks from the conversation and share results while you keep talking. Actions that need confirmation use the same screen cards as typed requests. Recognition may be uncertain; speech cannot approve an action.</p>
          : disclosed?.capabilities.finalTranscript !== "supported" && <p>Automatic tasks aren't available with this service. Review recognized text and use Send now.</p>}
        <p>{s.durableAvailable || client.historyOwnerFor(s.sessionId ?? "") ? "Recognized speech and generated voice replies are saved as text with this chat. This feature does not save audio. Reopening text does not replay audio or prove the voice service received this history." : "Live recognition is temporary and may be unavailable after reload."}</p>
        <p>Starting voice sends bounded prior chat text and completed results to this voice service, including when you switch services. Raw audio is not retained by this feature.</p>
        {coverage && <p>{coverage.state === "complete" ? "Available prior text was included in startup context." : coverage.state === "bounded" ? "Some prior text was omitted to fit startup context." : coverage.state === "partial" ? "Some prior discussion evidence or its original order is unavailable." : "Prior discussion evidence is unavailable."} {coverage.tailOmitted && (coverage.state === "partial" ? "The newest prior item may be missing." : "The newest prior item was not included.")} This does not prove the service understood or recalled it.</p>}
        <p>Spoken refusal is unavailable with the current voice services. Use Deny on screen.</p>
        {profile?.capabilities.exactPermissionSpeech !== "supported" && <p>Permission decisions remain on screen; spoken announcements are unavailable.</p>}
        {s.notice && <p>{s.notice}</p>}
        <div className="flex gap-2"><Button label="Start" style={button} disabled={!disclosed || chat !== "connected"} onClick={client.start} /><Button label="Cancel" style={button} tone="ghost" onClick={leave} /></div>
      </div>
    </Overlay>
  </div>;
}
