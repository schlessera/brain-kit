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
  const canShowReply = s.active && s.connection === "Connected" && !s.disclosureOpen && s.interaction !== "Checking whether the reply stopped";
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
  const lifetime = useRef(0);
  useEffect(() => {
    if (s.micOn && !wasOn.current) frame.current?.querySelector<HTMLElement>('[aria-label="Mute mic"]')?.focus();
    wasOn.current = s.micOn;
  }, [s.micOn]);
  // The component is a capture owner: a panel unmount cannot leave the mic live.
  useEffect(() => {
    const own = ++lifetime.current;
    return () => {
      client.mute("component-cleanup");
      queueMicrotask(() => { if (lifetime.current === own) client.leave(); });
    };
  }, [client]);
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
    {s.outputRecovery !== "open" && <div data-output-recovery="" className="flex items-center gap-2 text-xs">
      <span className="flex-1">{s.outputRecovery === "manual" ? "Output stays muted. No silence boundary found." : "Output muted during interruption recovery."} Microphone {s.micOn ? "on" : "off"}.</span>
      {s.outputRecovery === "manual" && <Button label="Recover audio" tone="ghost" style={button} onClick={client.recoverPlayback} />}
    </div>}
    {s.notice && <div role="status" aria-label="Voice notice" style={{ fontSize: 12, lineHeight: 1.3 }}>{s.notice}</div>}
    {s.text && <div className="min-[900px]:flex min-[900px]:items-center min-[900px]:gap-3">
      <div style={{ height: 64, overflowY: "auto", fontSize: 12, flex: "1 1 0", minWidth: 0 }} data-conversation-review="" tabIndex={0} role="region" aria-label="Unsent voice transcript" className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--bk-focus-ring)]">
        <div className="font-mono text-[10px]">Brain task not sent · saved draft</div>
        <div>{s.text}</div>
        <div>{needsScreen ? "This question needs the screen" : s.interaction === "Sending soon" ? "Sending soon" : "Review before sending as a Brain task"}</div>
      </div>
      <div className="w-full min-[900px]:w-[220px]" style={{ minHeight: 46, display: "flex", gap: 4 }}>
        <Button label="Send now" tone="primary" style={button} onClick={() => client.commit(s.token)} disabled={s.connection !== "Connected" || s.interaction === "Checking whether the reply stopped"} />
        <Button label="Discard" tone="ghost" style={button} onClick={client.discard} />
      </div>
    </div>}
    {permission.line && <div data-voice-refusal-window="" className="text-destructive" style={{ minHeight: 40, fontSize: 12 }}>{permission.line}</div>}
    <div className="sticky bottom-0 bg-background" style={{ minHeight: permission.line && s.text && shortScreen ? 44 : 52, display: "flex", alignItems: "center", gap: 4 }}>
      <Button label={s.micOn ? "Mute mic" : s.connection === "Connected" ? "Unmute mic" : "Resume"} ariaLabel={s.micOn ? "Mute mic" : "Resume microphone"} tone="ghost" style={control} onClick={s.micOn ? () => client.mute() : client.resume} />
      <Button label="Stop reply" tone="ghost" style={control} disabled={!replyVisible} onClick={client.stopReply} />
      <Button label="Leave voice" tone="ghost" style={control} onClick={leave} />
    </div>
    <Overlay open={s.disclosureOpen} variant="sheet" title="Live conversation" onClose={leave} data-overlay-site="conversation-disclosure">
      <div className="space-y-3 p-4 text-sm">
        <p>{profile?.disclosure.voiceService ?? "Connecting to the configured voice service…"}</p>
        <p>Evaluation only: interrupting ordinary speech keeps listening and mutes output until a silence boundary. Delayed earlier speech may return. Recover audio manually if output stays muted.</p>
        {profile?.disclosure.destinations.map((destination) => <p key={destination}>{destination}</p>)}
        <p>Host relay: {typeof window === "undefined" ? root.apiBase() || "this application’s host" : new URL(root.apiBase() || "/", window.location.href).origin}</p>
        <p>Brain task backend: {backend}. API destination and retention: unknown unless documented by the host. The voice service receives audio and can return transcription and spoken replies; Brain tasks receive text only after submission. This evaluation uses a scripted task executor, not a task model.</p>
        {profile?.capabilities.finalTranscript !== "supported" && <p>Automatic send isn't available with this service. Use Send now.</p>}
        <p>Spoken refusal is unavailable with the current voice services. Use Deny on screen.</p>
        {profile?.capabilities.exactPermissionSpeech !== "supported" && <p>Permission decisions remain on screen; spoken announcements are unavailable.</p>}
        {s.notice && <p>{s.notice}</p>}
        <div className="flex gap-2"><Button label="Start" style={button} disabled={!profile || s.connection !== "Connected"} onClick={client.start} /><Button label="Cancel" style={button} tone="ghost" onClick={leave} /></div>
      </div>
    </Overlay>
  </div>;
}
