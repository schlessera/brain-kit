import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent } from "react";
import { useStore } from "zustand";
import { VoiceControlButton, VoiceField, VoiceNotice, VoiceText, type IconName } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot } from "../../root-context.js";
import { conversationService, MUTED_NOTICE, READINESS_NOTICES, REVIEW_BOUNDED_NOTICE, REVIEW_TRIMMED_NOTICE, UNCLEAR_NOTICE, type ConversationClientState } from "../../voice/conversation-client.js";
import { PERMISSION_PENDING_LINE } from "../../voice/conversation-permissions.js";
import { ConversationStartCard } from "./start-card.js";

/** The live states the tall voice field draws (#3690); S5 is the Start sequence's Connecting. */
type LiveFieldState = "S5" | "L1" | "L2" | "L3" | "L4" | "L5" | "L6" | "L7" | "L8" | "L9";

/**
 * Maps the client's own state onto one live state. Every input is something
 * the client knows: its connection, capture intent, the playing reply, host
 * work and a pending approval card. `null` draws no field (before Start, or
 * while the Start card asks for one).
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

/* The signed-off copy for the field's body and meta (#3699). */
const DRAFT_META = "Draft · not sent yet";
const REFUSAL_LINE = "Tap Allow or Deny on the card. Voice can’t approve or refuse with this service.";
const OUTPUT_MUTED_LINE = "Brain’s voice was paused after a dropout. Replies still arrive as text.";
const OUTPUT_MUTED_NOTICE = "Reply audio is muted. Recover reply audio to listen; the microphone is unchanged.";
const READINESS_LINE = "Waiting for voice to be ready. Nothing is heard until then.";

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

/**
 * The live conversation surface: the tall voice field and nothing above it.
 * Its body holds one message, its controls row every action (#3699).
 */
export function ConversationField({ backend, onLeave }: { backend: string; onLeave: () => void }) {
  const root = useBrainUiRoot();
  const client = root.connection.conversation;
  const s = useStore(client.state);
  const permission = useStore(client.permissions.state);
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
  // A field control that held focus and is now disabled or gone (Interrupt
  // once the reply stops, Mute while voice readies, Send now after sending)
  // hands focus on rather than dropping it to the page (#3701): to Mute, or
  // to the first control still usable here (End, or L9's Close).
  const held = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const control = held.current;
    if (!control || control.isConnected && !(control as HTMLButtonElement).disabled) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== control) { held.current = null; return; }
    held.current = null;
    const usable = [...frame.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []];
    (usable.find(b => b.getAttribute("aria-label") === "Mute") ?? usable[0])?.focus({ preventScroll: true });
  });
  const onFocus = (event: FocusEvent) => {
    const target = event.target as HTMLElement;
    held.current = target.closest(".bk-voice-controls") ? target : null;
  };
  // Focus the user moved elsewhere is theirs. The check waits a task, since a
  // control being removed may blur while still attached; the effect above runs first.
  const onBlur = (event: FocusEvent) => {
    const target = event.target as HTMLButtonElement;
    setTimeout(() => { if (target === held.current && target.isConnected && !target.disabled) held.current = null; }, 0);
  };
  // Root-owned leases distinguish a true unmount from StrictMode or same-task
  // remounts. Component cleanup must never impersonate a manual Mute.
  useEffect(() => client.attachControls(), [client]);
  if (!s.active) return null;
  const profile = s.profile;
  const disclosed = s.conversationProfile;
  const leave = () => { client.leave(); onLeave(); };
  const service = profile ? conversationService(profile.providerId) : disclosed ? conversationService(disclosed.providerId) : null;
  const muted = s.capture === "muted";
  const draft = !!s.text;
  const outputMuted = s.outputRecovery === "muted";
  const readiness = (state === "S5" || state === "L8") && (Object.values(READINESS_NOTICES) as string[]).includes(s.notice);
  // The pending line is the field's own refusal copy; any other line (the request limit) is the client's.
  const refusal = permission.line === PERMISSION_PENDING_LINE ? REFUSAL_LINE : permission.line;
  // A line about the draft itself takes its words' place, as unclear audio does.
  const aboutDraft = s.notice === UNCLEAR_NOTICE || s.notice === REVIEW_BOUNDED_NOTICE || s.notice === REVIEW_TRIMMED_NOTICE;
  // Notices the field's word, meta or body already say.
  const repeated = s.notice === MUTED_NOTICE || s.notice === UNCLEAR_NOTICE || s.notice === OUTPUT_MUTED_NOTICE;
  // One message at a time, by priority: draft → refusal → output muted → client notice (#3699).
  const body = draft
    // Live draft words are `text` (the kit clamps them); every message is `children`, never clamped.
    ? <div data-conversation-review="" style={{ display: "contents" }}>{aboutDraft ? <VoiceText>{s.notice}</VoiceText> : <VoiceText text={s.text} />}</div>
    : refusal ? <VoiceText>{refusal}</VoiceText>
    : outputMuted ? <VoiceText>{OUTPUT_MUTED_LINE}</VoiceText>
    : readiness ? <VoiceText>{READINESS_LINE}</VoiceText>
    : s.notice && !repeated ? <VoiceText>{s.notice}</VoiceText>
    : null;
  const meta = draft ? DRAFT_META : outputMuted ? "Reply audio off" : readiness ? "mic off"
    : [service, state === "S5" ? null : clock(seconds)].filter(Boolean).join(" · ") || undefined;
  // L6 is an approval request: said at once, with how to answer it (#3701).
  // The label still says "Needs your tap" politely; this adds what to tap.
  const urgent = !s.disclosureOpen && state === "L6" ? refusal || "Tap Allow or Deny on the card." : "";
  return <div ref={frame} data-conversation-field="" data-live-state={s.disclosureOpen ? undefined : state ?? undefined} data-voice-refusal-window={permission.line ? "" : undefined} className="mx-auto max-w-3xl bg-background text-foreground" style={{ overflowWrap: "anywhere" }}
    onFocus={onFocus} onBlur={onBlur}>
    <div className="sr-only" aria-live="polite" aria-atomic="true">{s.announcement}</div>
    <div className="sr-only" aria-live="assertive" aria-atomic="true" data-conversation-urgent="">{urgent}</div>
    {s.disclosureOpen ? null : state === "L9"
      ? <div className="pb-2"><VoiceNotice tone="fail" icon="attention" live="assertive" title="Live conversation stopped" body={s.notice || undefined}
          actions={[{ label: "Close", onClick: leave }, { label: "Start again", tone: "brain", onClick: client.details }]} /></div>
      : state && <div className="pb-2">
        <VoiceField shape="tall" name="Live conversation" tone={LOOKS[state].tone} outline={LOOKS[state].outline}
          label={{ icon: LOOKS[state].icon, word: LOOKS[state].word, spin: LOOKS[state].spin, meta, live: "polite" }}
          meter={meter} level={meter === "level" ? level : undefined}
          controls={<>
            <VoiceControlButton name={muted ? "Unmute" : "Mute"} icon={muted ? "mic-off" : "mic"} pressed={muted} disabled={state === "S5" || readiness} onClick={muted ? client.resume : client.mute} />
            {/* Recovery stays manual and visible for as long as reply audio is off, even under a draft. */}
            {outputMuted
              ? <VoiceControlButton name="Recover reply audio" icon="speaker" tone="brain" onClick={client.recoverOutput} />
              // R1: a held draft takes Interrupt's place unless brain is speaking.
              : (!draft || state === "L4") && <VoiceControlButton name="Interrupt" icon="interrupt" disabled={state !== "L4"} onClick={client.stopReply} />}
            {draft && <>
              <VoiceControlButton name="Discard draft" icon="backspace" onClick={client.discard} />
              <VoiceControlButton name="Send now" icon="send" tone="you" disabled={s.connection !== "Connected" || s.interaction === "Checking whether the reply stopped"} onClick={() => client.commit(s.token)} />
            </>}
            <VoiceControlButton name="End" icon="dismiss" tone="end" onClick={leave} />
          </>}>
          {body}
        </VoiceField>
      </div>}
    {s.disclosureOpen && <div className="pb-2"><ConversationStartCard backend={backend} onLeave={onLeave} /></div>}
  </div>;
}
