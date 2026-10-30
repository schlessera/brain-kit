import { DraftSaveLine } from "../chat/draft-save-line.js";
import { useMediaQuery } from "../../hooks/use-media-query.js";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { Button, Overlay } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot } from "../../root-context.js";

/** The voice controls live below the ordinary transcript and its interactive cards. */
export function ConversationStrip({ backend, onLeave }: { backend: string; onLeave: () => void }) {
  const root = useBrainUiRoot();
  const client = root.connection.conversation;
  const s = useStore(client.state);
  const permission = useStore(client.permissions.state);
  const shortScreen = useMediaQuery("(max-height: 580px)");
  const chat = useStore(root.stores.connection, (state) => state.wsStatus);
  const needsScreen = useStore(root.stores.chat, (state) => {
    const exchange = (s.sessionId === null ? state.draft : state.buffers[s.sessionId])?.askUser;
    return !!exchange && !exchange.cancelled && !exchange.answers && !exchange.order && !exchange.formAnswers && (exchange.questions.length !== 1 || !!exchange.list || !!exchange.rank || !!exchange.form);
  });
  // This hold is presentation only: PCM capture and interruption use the
  // client's instantaneous playing state, never this display state.
  const [replyToken, setReplyToken] = useState<number | null>(null);
  const canShowReply = s.active && s.connection === "Connected" && s.outputRecovery === "audible" && !s.disclosureOpen && s.interaction !== "Checking whether the reply stopped";
  const replyVisible = canShowReply && (s.playing || replyToken === s.token);
  const interaction = replyVisible ? "Speaking" : s.interaction;
  useEffect(() => {
    if (!canShowReply) { setReplyToken(null); return; }
    if (s.playing) { setReplyToken(s.token); return; }
    const timeout = setTimeout(() => setReplyToken(null), 300);
    return () => clearTimeout(timeout);
  }, [canShowReply, s.playing, s.token]);
  const frame = useRef<HTMLDivElement>(null);
  const wasOn = useRef(false);
  useEffect(() => {
    if (s.micOn && !wasOn.current) frame.current?.querySelector<HTMLElement>('[aria-label="Mute mic"]')?.focus();
    wasOn.current = s.micOn;
  }, [s.micOn]);
  // Root-owned leases distinguish a true unmount from StrictMode or same-task
  // remounts. Component cleanup must never impersonate a manual Mute.
  useEffect(() => client.attachControls(), [client]);
  if (!s.active) return null;
  const profile = s.profile;
  const button = { minHeight: 44, minWidth: 44, flex: "1 1 0", width: "auto", padding: "0 6px", fontSize: 12 };
  const control = { ...button, padding: "0 2px" };
  const leave = () => { client.leave(); onLeave(); };
  return <div ref={frame} data-conversation-strip="" className="mx-auto max-w-3xl border-t border-border bg-background text-foreground" style={{ overflowWrap: "anywhere", maxHeight: "60dvh", overflowY: "auto" }}>
    <div className="sr-only" aria-live="polite" aria-atomic="true">{s.announcement}</div>
    <div style={{ minHeight: 44, display: "flex", alignItems: "center", gap: 4, fontSize: 12, lineHeight: 1.3 }}>
      <div style={{ flex: 1, minWidth: 0 }} className={s.micOn ? "text-[var(--bk-teal-ink)]" : interaction === "Working" || interaction === "Speaking" ? "text-[var(--bk-amber-ink)]" : undefined}>
        <div>{s.micOn ? "●" : "○"} {interaction} · mic {s.micOn ? "on" : "off"}</div>
        <div>{s.connection} · chat: {chat === "connected" ? "ok" : "lost"}</div>
      </div>
      <Button label={`${profile?.providerId ?? "Voice"} ⓘ`} ariaLabel="Voice service details" tone="ghost" size="sm" block={false} style={{ minHeight: 44, minWidth: 44, maxWidth: 96, padding: "0 4px", fontSize: 11 }} onClick={client.details} />
    </div>
    {s.outputRecovery === "muted" && <Button label="Recover reply audio" tone="ghost" style={button} onClick={client.recoverOutput} />}
    {s.notice && <div role="status" aria-label="Voice notice" style={{ fontSize: 12, lineHeight: 1.3 }}>{s.notice}</div>}
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
    {Object.values(s.work).some(w => w.provenance === "contextual") && <details aria-label="Conversation tasks" className="py-2 text-xs">
      <summary className="min-h-11 cursor-pointer">Background tasks</summary>
      <ul>{Object.values(s.work).filter(w => w.provenance === "contextual").slice(-8).map(w => <li key={w.requestId} className="py-1">
        <p>Context: {w.recognized.slice(-160)}</p>
        Conversation task · {w.state} · {w.delivery === "returned" ? "result accepted by voice service; playback unknown" : w.delivery === "unknown" ? "result acceptance unknown; no automatic replay" : w.delivery === "pending" ? "result pending" : "result withheld"}
        {w.reason && <p>{w.reason}</p>}
      </li>)}</ul>
    </details>}
    {permission.line && <div data-voice-refusal-window="" className="text-destructive" style={{ minHeight: 40, fontSize: 12 }}>{permission.line}</div>}
    <div className="sticky bottom-0 bg-background" style={{ minHeight: permission.line && s.text && shortScreen ? 44 : 52, display: "flex", alignItems: "center", gap: 4 }}>
      <Button label={s.micOn ? "Mute mic" : s.connection === "Connected" ? "Unmute mic" : "Resume"} ariaLabel={s.micOn ? "Mute mic" : "Resume microphone"} tone="ghost" style={control} onClick={s.micOn ? client.mute : client.resume} />
      <Button label="Stop reply" tone="ghost" style={control} disabled={!replyVisible} onClick={client.stopReply} />
      <Button label="Leave voice" tone="ghost" style={control} onClick={leave} />
    </div>
    <Overlay open={s.disclosureOpen} variant="sheet" title="Live conversation" onClose={leave} data-overlay-site="conversation-disclosure">
      <div className="space-y-3 p-4 text-sm">
        <p>{profile?.disclosure.voiceService ?? "Connecting to the configured voice service…"}</p>
        {profile?.disclosure.destinations.map((destination) => <p key={destination}>{destination}</p>)}
        <p>Host relay: {typeof window === "undefined" ? root.apiBase() || "this application’s host" : new URL(root.apiBase() || "/", window.location.href).origin}</p>
        <p>Independently selected agent backend: {backend}. API destination and retention: unknown unless documented by the host.</p>
        {profile?.capabilities.contextualTasks === "supported"
          ? <p>Brain can start permitted background tasks from the conversation and share results while you keep talking. Actions that need confirmation use the same screen cards as typed requests. Recognition may be uncertain; speech cannot approve an action.</p>
          : profile?.capabilities.finalTranscript !== "supported" && <p>Automatic tasks aren't available with this service. Review recognized text and use Send now.</p>}
        <p>Live recognition is temporary and may be unavailable after reload.</p>
        <p>Spoken refusal is unavailable with the current voice services. Use Deny on screen.</p>
        {profile?.capabilities.exactPermissionSpeech !== "supported" && <p>Permission decisions remain on screen; spoken announcements are unavailable.</p>}
        {s.notice && <p>{s.notice}</p>}
        <div className="flex gap-2"><Button label="Start" style={button} disabled={!profile || s.connection !== "Connected"} onClick={client.start} /><Button label="Cancel" style={button} tone="ghost" onClick={leave} /></div>
      </div>
    </Overlay>
  </div>;
}
