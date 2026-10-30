import { Button } from "@schlessera/brain-ui-kit";
import type { TranscriptEntry } from "../../lib/transcript-timeline.js";
import { conversationService, type ConversationRecognition, type ConversationClientOutput } from "../../voice/conversation-client.js";
import type { ChatMessage } from "../../stores/chat-state.js";
import { useStore } from "zustand";
import { useBrainUiRoot } from "../../root-context.js";
import { TurnHeader } from "../chat/transcript-turn.js";

/** Voice-generated words share Chat's scrolling transcript; they never replace backend progress. */
export function ConversationPermissionOutcomes({ sessionId }: { sessionId: string | null }) {
  const root = useBrainUiRoot();
  const permission = useStore(root.connection.conversation.permissions.state);
  const buffer = useStore(root.stores.chat, state => sessionId === null ? state.draft : state.buffers[sessionId]);
  const tools = buffer?.messages.flatMap(m => m.toolCalls) ?? [];
  return <>{permission.records.filter(r => r.sessionId === sessionId && r.word && (r.postureDenied || r.heardAt && !tools.some(t => t.id === r.toolUseId))).map(r => <p key={`posture:${r.turnId}:${r.toolUseId}`} data-voice-posture-outcome={r.postureDenied ? "" : undefined} data-voice-permission-outcome="" className="py-2 text-xs">{r.word}</p>)}
  </>;
}

/** A display segment retains the engine's output identity and playback evidence. */
export function ConversationOutput({ output, restored = false, arrivalKey }: { output: ConversationClientOutput; restored?: boolean; arrivalKey?: string }) {
  return <div className="py-4" data-arrival-key={arrivalKey} tabIndex={-1} data-conversation-output="" data-output-id={output.outputId}>
    <TurnHeader who={`Voice reply · ${output.providerId ? conversationService(output.providerId) : "service unknown"}`} tone="brain" />
    <p className="whitespace-pre-wrap">{output.generated}</p>
    <p className="mt-2 text-xs text-muted-foreground">{restored ? "Restored generated speech · original discussion position unknown · " : "Generated speech · "}{output.playback === "played" ? "received audio chunks played; spoken portion unknown" : output.playback === "discarded" ? "rest of reply · not spoken" : "spoken portion unknown"}</p>
  </div>;
}

/** Exact host task/turn evidence, never a guessed association with recognized input. */
export function ConversationTaskContext({ message, sessionId, result, entries = [], onReveal }: { message: ChatMessage; sessionId: string | null; result?: boolean; entries?: TranscriptEntry[]; onReveal?: (key: string) => void }) {
  const root = useBrainUiRoot();
  const work = useStore(root.connection.conversation.state, s => s.work);
  const receipt = Object.values(work).find(w => w.provenance === "contextual" && w.sessionId === sessionId
    && ((message.turnId ?? message.streamTurnId) ? w.turnId === (message.turnId ?? message.streamTurnId) : !!message.requestId && w.requestId === message.requestId));
  if (!receipt) return null;
  if (result) {
    const request = entries.find(e => e.kind === "message" && e.sessionId === sessionId && e.message.role === "user" && e.message.source === "voice-context"
      && (e.message.requestId === receipt.requestId || !!receipt.turnId && (e.message.turnId ?? e.message.streamTurnId) === receipt.turnId));
    return <div className="py-2 text-xs text-muted-foreground" data-conversation-task-result="" style={{ overflowWrap: "anywhere" }}>
      <p>Task result · {receipt.submitted.slice(0, 160)}</p>
      {request && onReveal ? <Button label="View request" tone="ghost" block={false} style={{ minHeight: 44 }} onClick={() => onReveal(request.key)} /> : <p>Request details unavailable</p>}
    </div>;
  }
  return <details className="py-2 text-sm" data-conversation-task="" style={{ overflowWrap: "anywhere" }}>
    <summary className="min-h-11 cursor-pointer">Background task · {receipt.state}</summary>
    <p>Host task context · recognition may be uncertain. This is not a verified user quote.</p>
    <p className="whitespace-pre-wrap">{receipt.submitted}</p>
  </details>;
}

/** Readable uncertain evidence, outside user-message and live-announcement regions. */
export function ConversationRecognitionRow({ fragments, introduction = false }: { fragments: ConversationRecognition[]; introduction?: boolean }) {
  const first = fragments[0]!;
  const service = conversationService(first.providerId);
  return <section className="py-4 text-foreground" data-conversation-recognition="" aria-label={`Recognized speech · ${service} · unverified`} style={{ overflowWrap: "anywhere" }}>
    {introduction && <p className="mb-3 text-xs text-muted-foreground">Audio goes to {service}. Recognized words may be uncertain. Brain tasks and their results are shown separately.{first.contextual && " Permitted tasks can start while you talk."}</p>}
    <TurnHeader who="Recognized speech" tone="neutral" />
    <p className="mb-2 text-xs text-muted-foreground">{service} · unverified{fragments.some(f => f.finalization === "interim") ? " · Updating recognition" : ""}</p>
    <p className="whitespace-pre-wrap" data-recognized-text="">{fragments.every(f => f.moved) ? "Moved to voice review" : fragments.map(f => f.text).join("")}</p>
    <details className="mt-2 text-xs text-muted-foreground">
      <summary className="min-h-11 cursor-pointer">Recognition details</summary>
      <p>Live recognition is temporary and may be unavailable after reload. Display order is received content, not exact response pairing.</p>
      <ol>{fragments.map(f => <li key={JSON.stringify([f.kind, f.sequence])} className="py-1">
        Epoch {f.epoch} · fragment {f.sequence} · {f.kind === "input_fragment" ? `Captured input ${f.utteranceId}; speaker unverified` : "Unassigned input; speaker unverified"}.
        {f.kind === "unassigned_input_fragment" && f.sessionInterval ? ` Provider session timing; approximate: ${f.sessionInterval.startMs}–${f.sessionInterval.endMs} ms.` : f.kind === "input_fragment" && f.interval ? ` Provider input timing: ${f.interval.startMs}–${f.interval.endMs} ms.` : " Timing unavailable; speaker unverified."}
        {f.finalization === "final" ? " Service finish marker received." : f.finalization === "interim" ? " Updating recognition." : " No finish evidence."}
      </li>)}</ol>
    </details>
  </section>;
}
