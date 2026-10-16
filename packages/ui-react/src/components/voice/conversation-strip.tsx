import { useEffect, useRef } from "react";
import { useStore } from "zustand";
import { Button, Overlay } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot } from "../../root-context.js";

/** The voice controls live below the ordinary transcript and its interactive cards. */
export function ConversationStrip({ backend, onLeave }: { backend: string; onLeave: () => void }) {
  const root = useBrainUiRoot();
  const client = root.connection.conversation;
  const s = useStore(client.state);
  const chat = useStore(root.stores.connection, (state) => state.wsStatus);
  const needsScreen = useStore(root.stores.chat, (state) => {
    const exchange = (s.sessionId === null ? state.draft : state.buffers[s.sessionId])?.askUser;
    return !!exchange && !exchange.cancelled && !exchange.answers && !exchange.order && !exchange.formAnswers && (exchange.questions.length !== 1 || !!exchange.list || !!exchange.rank || !!exchange.form);
  });
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
      client.mute();
      queueMicrotask(() => { if (lifetime.current === own) client.leave(); });
    };
  }, [client]);
  if (!s.active) return null;
  const profile = s.profile;
  const button = { minHeight: 44, minWidth: 44, flex: "1 1 0", width: "auto", padding: "0 6px", fontSize: 12 };
  const leave = () => { client.leave(); onLeave(); };
  return <div ref={frame} data-conversation-strip="" className="mx-auto max-w-3xl border-t border-border bg-background text-foreground" style={{ overflowWrap: "anywhere" }}>
    <div className="sr-only" aria-live="polite" aria-atomic="true">{s.announcement}</div>
    <div style={{ height: 44, display: "flex", alignItems: "center", gap: 4, fontSize: 12, lineHeight: "13px" }}>
      <div style={{ flex: 1, minWidth: 0 }} className={s.micOn ? "text-[var(--bk-teal-ink)]" : s.interaction === "Working" || s.interaction === "Speaking" ? "text-[var(--bk-amber-ink)]" : undefined}>
        <div>{s.micOn ? "●" : "○"} {s.interaction} · mic {s.micOn ? "on" : "off"}</div>
        <div title={s.notice || undefined} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.connection} · chat: {chat === "connected" ? "ok" : "lost"}{s.notice && !s.text ? ` · ${s.notice}` : ""}</div>
      </div>
      <Button label={`${profile?.providerId ?? "Voice"} ⓘ`} ariaLabel="Voice service details" tone="ghost" size="sm" block={false} style={{ minHeight: 44, minWidth: 44, maxWidth: 96, padding: "0 4px", fontSize: 11 }} onClick={client.details} />
    </div>
    {s.text && <div className="min-[900px]:flex min-[900px]:items-center min-[900px]:gap-3">
      <div style={{ height: 64, overflowY: "auto", fontSize: 12, flex: "1 1 0", minWidth: 0 }} data-conversation-review="">
        <div className="font-mono text-[10px]">NOT SENT · SAVED AS DRAFT</div>
        <div>{s.text}</div>
        <div>{needsScreen ? "This question needs the screen" : s.interaction === "Sending soon" ? "Sending soon" : "Review before sending"}</div>
        {s.notice.startsWith("I couldn") && <div>{s.notice}</div>}
      </div>
      <div className="w-full min-[900px]:w-[220px]" style={{ height: 46, display: "flex", gap: 4 }}>
        <Button label="Send now" tone="primary" style={button} onClick={() => client.commit(s.token)} disabled={s.connection !== "Connected" || s.interaction === "Checking whether the reply stopped"} />
        <Button label="Discard" tone="ghost" style={button} onClick={client.discard} />
      </div>
    </div>}
    <div style={{ height: 52, display: "flex", alignItems: "center", gap: 4 }}>
      <Button label={s.micOn ? "Mute mic" : s.connection === "Connected" ? "Unmute mic" : "Resume"} ariaLabel={s.micOn ? "Mute mic" : "Resume microphone"} tone="ghost" style={button} onClick={s.micOn ? client.mute : client.resume} />
      {s.playing && <Button label="Stop reply" tone="ghost" style={button} onClick={client.stopReply} />}
      <Button label="Leave voice" tone="ghost" style={button} onClick={leave} />
    </div>
    <Overlay open={s.disclosureOpen} variant="sheet" title="Live conversation" onClose={leave} data-overlay-site="conversation-disclosure">
      <div className="space-y-3 p-4 text-sm">
        <p>{profile?.disclosure.voiceService ?? "Connecting to the configured voice service…"}</p>
        {profile?.disclosure.destinations.map((destination) => <p key={destination}>{destination}</p>)}
        <p>Host relay: {typeof window === "undefined" ? root.apiBase() || "this application’s host" : new URL(root.apiBase() || "/", window.location.href).origin}</p>
        <p>Independently selected agent backend: {backend}. API destination and retention: unknown unless documented by the host.</p>
        {profile?.capabilities.finalTranscript !== "supported" && <p>Automatic send isn't available with this service. Use Send now.</p>}
        {profile?.capabilities.echoIsolatedInput !== "supported" && <p>Refusal by voice needs headphones with this service.</p>}
        {profile?.capabilities.exactPermissionSpeech !== "supported" && <p>Permission decisions remain on screen; spoken announcements are unavailable.</p>}
        {s.notice && <p>{s.notice}</p>}
        <div className="flex gap-2"><Button label="Start" disabled={!profile || s.connection !== "Connected"} onClick={client.start} /><Button label="Cancel" tone="ghost" onClick={leave} /></div>
      </div>
    </Overlay>
  </div>;
}
