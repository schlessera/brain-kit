import { Button } from "@schlessera/brain-ui-kit";
import { TranscriptQualifiers, TranscriptSymbols } from "@schlessera/brain-ui-kit/internal";
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
    <TurnHeader who="Voice reply" tone="brain" />
    <div className="whitespace-pre-wrap" style={{ overflowWrap: "anywhere" }}>{output.generated}<TranscriptQualifiers kind="generated" source={output.providerId ? conversationService(output.providerId) : undefined}
      playback={output.playback === "discarded" ? "not-spoken" : output.playback} restored={restored} unsaved={output.unsaved} orderUnknown={output.orderUnknown ?? restored} evidenceLabel="Technical evidence (generated reply)">
      <p>Conversation {output.conversationId} · epoch {output.epoch} · output {output.outputId}</p>
      {output.playedSamples && <p>Reported local samples: {output.playedSamples.start}–{output.playedSamples.end}. This does not align text to audio.</p>}
    </TranscriptQualifiers></div>
    {(output.orderUnknown ?? restored) && <p className="mt-2 text-xs text-muted-foreground">Original discussion position unknown.</p>}
  </div>;
}

/** Exact host task/turn evidence, never a guessed association with recognized input. */
export function ConversationTaskContext({ message, sessionId, result, entries = [], onReveal }: { message: ChatMessage; sessionId?: string | null; result?: boolean; entries?: TranscriptEntry[]; onReveal?: (key: string) => void }) {
  const root = useBrainUiRoot();
  const activeSession = useStore(root.stores.chat, s => s.activeSessionId);
  const owner = sessionId === undefined ? activeSession : sessionId;
  const work = useStore(root.connection.conversation.state, s => s.work);
  const receipt = Object.values(work).find(w => w.provenance === "contextual" && w.sessionId === owner
    && ((message.turnId ?? message.streamTurnId) ? w.turnId === (message.turnId ?? message.streamTurnId) : !!message.requestId && w.requestId === message.requestId));
  if (!receipt && (result || message.source !== "voice-context")) return null;
  const linked = receipt && entries.find(e => e.kind === "message" && e.sessionId === owner
    && e.message.role === (result ? "user" : "assistant") && (result ? e.message.source === "voice-context" : e.section !== "progress" && e.message.parts.some(p => p.kind === "text" && p.text.length > 0))
    && (e.message.requestId === receipt.requestId || !!receipt.turnId && (e.message.turnId ?? e.message.streamTurnId) === receipt.turnId));
  const states: Record<string, string> = { queued: "Queued", running: "Running", completed: "Complete", error: "Failed", refused: "Refused", unknown: "State unknown", cancelled: "Cancelled", denied: "Denied", withdrawn: "Withdrawn" };
  return <div className="py-2 text-sm text-foreground" data-conversation-task={result ? undefined : ""} data-conversation-task-result={result ? "" : undefined} style={{ overflowWrap: "anywhere" }}>
    <span>{result ? "Task result" : "Conversation task"}{receipt ? ` · ${states[receipt.state] ?? receipt.state}` : " · State unavailable"}</span><TranscriptQualifiers
      kind={result ? "task-result" : "task-request"} source="host task" evidenceLabel="Technical evidence (host request)">
      {receipt && <p>Conversation {receipt.conversationId} · epoch {receipt.epoch} · request {receipt.requestId}{receipt.turnId ? ` · turn ${receipt.turnId}` : ""}</p>}
      <p>Submitted host instruction</p><pre>{receipt?.submitted ?? message.content}</pre>
      {receipt?.reason && <p>{receipt.reason}</p>}
    </TranscriptQualifiers>
    {receipt?.reason && ["error", "refused", "unknown"].includes(receipt.state) && <p>{receipt.reason}</p>}
    {linked && onReveal ? <Button label={result ? "View request" : "View result"} tone="ghost" block={false} style={{ minHeight: 44 }} onClick={() => onReveal(linked.key)} /> : result ? <p>Request details unavailable</p> : null}
  </div>;
}

/** Readable uncertain evidence, outside user-message and live-announcement regions. */
export function ConversationRecognitionRow({ fragments, introduction = false }: { fragments: ConversationRecognition[]; introduction?: boolean }) {
  const first = fragments[0]!;
  const service = conversationService(first.providerId);
  const updating = fragments.filter(f => f.finalization === "interim").length;
  const finish = updating ? updating === fragments.length ? "updating" : "some-updating" : fragments.some(f => f.finalization === "final") ? "finished" : "unknown";
  return <section className="py-4 text-foreground" data-conversation-recognition="" style={{ overflowWrap: "anywhere" }}>
    {introduction && <div className="mb-3 text-xs text-muted-foreground">Voice · {service} <TranscriptSymbols /></div>}
    <TurnHeader who="Recognized speech" tone="neutral" />
    <div className="whitespace-pre-wrap"><span data-recognized-text="">{fragments.every(f => f.moved) ? "Moved to voice review" : fragments.map(f => f.text).join("")}</span><TranscriptQualifiers
      kind="recognized" source={service} finish={finish} unsaved={first.unsaved} restored={fragments.some(f=>f.restored)} orderUnknown={fragments.some(f=>f.orderUnknown)} evidenceLabel={`Technical evidence (${fragments.length} fragment${fragments.length === 1 ? "" : "s"})`}>
      <p>Recognized text evidence. Display order does not establish an exact response pairing.</p>
      <ol>{fragments.map(f => <li key={JSON.stringify([f.kind, f.sequence])} className="py-1">
        Epoch {f.epoch} · fragment {f.sequence} · {f.kind === "input_fragment" ? `Captured input ${f.utteranceId}; speaker unverified` : "Unassigned input; speaker unverified"}.
        {f.kind === "unassigned_input_fragment" && f.sessionInterval ? ` Provider session timing; approximate: ${f.sessionInterval.startMs}–${f.sessionInterval.endMs} ms.` : f.kind === "input_fragment" && f.interval ? ` Provider input timing: ${f.interval.startMs}–${f.interval.endMs} ms.` : " Timing unavailable; speaker unverified."}
        {f.finalization === "final" ? " Service finish marker received." : f.finalization === "interim" ? " Updating recognition." : " No finish evidence."}
      </li>)}</ol>
    </TranscriptQualifiers></div>
  </section>;
}
