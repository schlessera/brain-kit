import { useEffect, useRef, useState } from "react";
import { Button, Callout } from "@schlessera/brain-ui-kit";
import { stateRoomCopy, stateRoomWarning } from "@schlessera/brain-ui-sdk/protocol";
import { useBrainUiRoot } from "../../root-context.js";
import { useChatStore } from "../../stores/chat-store.js";
import { useProviderStore } from "../../stores/provider-store.js";
import { useConnectionStore } from "../../stores/connection-store.js";
import { useVoiceStore } from "../../voice/voice-store.js";
import { useWorkerHostStatus } from "../../hooks/use-worker-host.js";
import { unavailableReasonCopy } from "./handoff-sheet.js";

function observationAge(observedAt: number, now: number): string {
  if (observedAt > now) return `recorded ${new Date(observedAt).toLocaleString("en-US")}`;
  const seconds = Math.floor((now - observedAt) / 1000);
  if (seconds < 60) return "less than a minute ago";
  const unit = seconds < 3600 ? "minute" : seconds < 86400 ? "hour" : "day";
  const amount = Math.floor(seconds / (unit === "minute" ? 60 : unit === "hour" ? 3600 : 86400));
  return new Intl.RelativeTimeFormat("en-US", { numeric: "always" }).format(-amount, unit);
}

/** A measured warning beside the composer; neither this notice nor dismissal changes admission. */
export function StateRoomNotice({ onDismissFocus }: { onDismissFocus: () => void }) {
  const root = useBrainUiRoot();
  const sessionId = useChatStore(s => s.activeSessionId);
  const room = useChatStore(s => sessionId ? s.stateRooms[sessionId] : undefined);
  const preference = useChatStore(s => sessionId ? s.stateRoomPreferences[sessionId] : undefined);
  const backendId = useChatStore(s => sessionId ? s.backendIds[sessionId] : undefined);
  const messages = useChatStore(s => sessionId ? s.buffers[sessionId]?.messages : undefined);
  const backends = useProviderStore(s => s.backends);
  const providers = useProviderStore(s => s.available);
  const unavailable = useProviderStore(s => s.unavailable);
  const pinnedId = useProviderStore(s => s.pinnedId);
  const connected = useConnectionStore(s => s.wsStatus === "connected");
  const voiceMode = useVoiceStore(s => s.mode);
  const localCapture = useVoiceStore(s => s.local);
  const { status } = useWorkerHostStatus();
  const [now, setNow] = useState(Date.now);
  const [announcement, setAnnouncement] = useState("");
  const announcedObservation = useRef<typeof observation>(undefined);
  const observation = room?.observation;
  const reportedAllowance = backendId ? backends[backendId]?.stateRoomAllowance : undefined;
  // A newer host configuration invalidates an old ratio. An older roster
  // cannot invalidate a newer actual admission observation.
  const changedAllowance = Boolean(observation && reportedAllowance
    && reportedAllowance.observedAt >= observation.observedAt && reportedAllowance.bytes !== observation.allowanceBytes);
  const failure = messages?.findLast(message => message.role === "assistant")?.failure?.errorClass;
  const refused = failure === "session_too_large" || failure === "worker_state_exceeded" || failure === "worker_state_busy";
  const visible = Boolean(sessionId && observation && stateRoomWarning(observation) && !changedAllowance && !refused
    && preference?.dismissedAllowance !== observation.allowanceBytes
    && (preference?.invalidatedAt === undefined || observation.observedAt > preference.invalidatedAt));
  const voiceActive = voiceMode !== "idle" || localCapture !== "idle";

  useEffect(() => {
    if (sessionId && observation && changedAllowance) root.stores.chat.getState().invalidateStateRoom(sessionId, observation.observedAt);
  }, [root, sessionId, observation, changedAllowance]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!visible || !sessionId || !observation) { setAnnouncement(""); return; }
    const alreadyAnnounced = root.stores.chat.getState().stateRoomAnnouncements[sessionId] === observation.allowanceBytes;
    if (voiceActive || room?.historical) {
      if (!alreadyAnnounced) root.stores.chat.getState().markStateRoomAnnounced(sessionId, observation.allowanceBytes);
      announcedObservation.current = observation;
      setAnnouncement(""); return;
    }
    if (!alreadyAnnounced) {
      setAnnouncement(stateRoomCopy(observation));
      announcedObservation.current = observation;
      root.stores.chat.getState().markStateRoomAnnounced(sessionId, observation.allowanceBytes);
    } else if (announcedObservation.current !== observation) setAnnouncement("");
  }, [visible, voiceActive, sessionId, observation, room?.historical, root]);

  if (!visible || !observation || !sessionId) return null;
  const blockedProfile = unavailable.find(profile => profile.id === pinnedId && profile.backendId === backendId)
    ?? unavailable.find(profile => profile.backendId === backendId);
  const sourceAvailable = providers.some(profile => profile.backendId === backendId);
  const why = !connected || status?.ordinary?.available === false ? "needs the host"
    : !sourceAvailable ? blockedProfile ? `${blockedProfile.label} ${unavailableReasonCopy(blockedProfile.reason)}` : "choose an available profile"
    : undefined;
  return <div data-state-room-notice="" className="mx-auto mb-3 w-full max-w-3xl">
    <div className="sr-only" role="status" aria-live={voiceActive ? "off" : "polite"} data-state-room-announcement="">{announcement}</div>
    <Callout tone="amber" variant="boxed">
      <div className="text-base leading-relaxed text-foreground">
        <p>{stateRoomCopy(observation)}</p>
        <p className="mt-1">Continue in a new conversation before it is full. This one stays available.</p>
        <p className="mt-1 text-sm text-muted-foreground">As of the last turn · {observationAge(observation.observedAt, now)}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button label="Continue in a new conversation" tone="suggest" block={false} disabled={Boolean(why)}
            style={{ minHeight: 44, maxWidth: "100%", fontSize: 14 }}
            onClick={() => root.stores.handoff.getState().open(sessionId, crypto.randomUUID(), { preferSourceProfile: true })} />
          <Button label="Not now" tone="quiet" block={false} style={{ minHeight: 44, fontSize: 14 }}
            onClick={() => { root.stores.chat.getState().dismissStateRoom(sessionId, observation.allowanceBytes); onDismissFocus(); }} />
        </div>
        {why && <p className="mt-1 text-sm text-muted-foreground">{why}</p>}
      </div>
    </Callout>
  </div>;
}
