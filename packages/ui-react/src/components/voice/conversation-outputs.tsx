import { Button, Callout, SpokenTurn, TextButton, UncertainWord } from "@schlessera/brain-ui-kit";
import { TranscriptQualifiers, TranscriptSymbols } from "@schlessera/brain-ui-kit/internal";
import type { TranscriptEntry } from "../../lib/transcript-timeline.js";
import { conversationService, type ConversationRecognition, type ConversationClientOutput } from "../../voice/conversation-client.js";
import type { ChatMessage } from "../../stores/chat-state.js";
import { useStore } from "zustand";
import { useBrainUiRoot } from "../../root-context.js";

/**
 * The confidence below which the conversation client already holds captured
 * input for review instead of sending it (`conversation-client.ts`). Only a
 * calibrated score (`certainty: "known"`) below it marks words uncertain; an
 * absent score is no evidence either way, so nothing is marked.
 */
const REVIEW_CONFIDENCE = 0.9;
const uncertain = (f: ConversationRecognition) => f.kind === "input_fragment" && f.certainty === "known" && f.confidence !== undefined && f.confidence < REVIEW_CONFIDENCE;

/** The dotted underline covers the fragment the score describes, never its surrounding spaces. */
function RecognizedWords({ fragment }: { fragment: ConversationRecognition }) {
  if (!uncertain(fragment)) return <>{fragment.text}</>;
  const [, lead = "", words = "", trail = ""] = /^(\s*)([\s\S]*?)(\s*)$/.exec(fragment.text) ?? [];
  return words ? <>{lead}<UncertainWord>{words}</UncertainWord>{trail}</> : <>{fragment.text}</>;
}

/**
 * R2 (#3699): a live conversation's startup-context coverage, inline at the
 * start of its live section. It says only what `historyCoverage` reports:
 * the host's count of messages sent, or, from an older host without one, the
 * coverage state. Details opens the disclosure sheet while that conversation is live.
 */
export function ConversationCoverageNotice({ conversationId, coverage }: { conversationId: string; coverage: { state: string; tailOmitted: boolean; includedMessages?: number } }) {
  const client = useBrainUiRoot().connection.conversation;
  const live = useStore(client.state, s => s.active && s.profile?.conversationId === conversationId);
  const n = coverage.includedMessages ?? 0;
  const text = n > 0 ? `Started with the last ${n} ${n === 1 ? "message" : "messages"}`
    : coverage.tailOmitted ? coverage.state === "partial" ? "Newest prior context may be missing." : "Newest prior context was not sent." : "Prior context is incomplete.";
  return <div data-voice-coverage=""><Callout variant="plain" tone="neutral" icon="history">
    {text}{live && <> · <TextButton label="Details" ariaLabel="Prior context details" inline onClick={client.details} /></>}
  </Callout></div>;
}

/** Voice-generated words share Chat's scrolling transcript; they never replace backend progress. */
export function ConversationPermissionOutcomes({ sessionId }: { sessionId: string | null }) {
  const root = useBrainUiRoot();
  const permission = useStore(root.connection.conversation.permissions.state);
  const buffer = useStore(root.stores.chat, state => sessionId === null ? state.draft : state.buffers[sessionId]);
  const tools = buffer?.messages.flatMap(m => m.toolCalls) ?? [];
  return <>{permission.records.filter(r => r.sessionId === sessionId && r.word && (r.postureDenied || r.heardAt && !tools.some(t => t.id === r.toolUseId))).map(r => <p key={`posture:${r.turnId}:${r.toolUseId}`} data-voice-posture-outcome={r.postureDenied ? "" : undefined} data-voice-permission-outcome="" className="py-2 text-xs">{r.word}</p>)}
  </>;
}

/**
 * A display segment retains the engine's output identity and playback evidence.
 * It reads as brain's spoken turn: the teal speaker mark, never a heard claim.
 * No text is dimmed as unplayed: the client knows which chunks drained, not
 * which words they carried (`playedSamples` does not align text to audio).
 * `cutOff` comes only from a retained interruption naming this output. The
 * turn's evidence opens from its own Details stop (#3728), never a glyph.
 */
export function ConversationOutput({ output, restored = false, arrivalKey, cutOff = false }: { output: ConversationClientOutput; restored?: boolean; arrivalKey?: string; cutOff?: boolean }) {
  return <div className="py-4" data-arrival-key={arrivalKey} tabIndex={-1} data-conversation-output="" data-output-id={output.outputId}>
    <SpokenTurn speaker="brain" cutOff={cutOff} details={{
      kind: "generated", source: output.providerId ? conversationService(output.providerId) : undefined,
      playback: output.playback === "discarded" ? "not-spoken" : output.playback, restored, unsaved: output.unsaved, orderUnknown: output.orderUnknown ?? restored, evidenceLabel: "Technical evidence (generated reply)",
      children: <>
        <p>Conversation {output.conversationId} · epoch {output.epoch} · output {output.outputId}</p>
        {output.playedSamples && <p>Reported local samples: {output.playedSamples.start}–{output.playedSamples.end}. This does not align text to audio.</p>}
      </>,
    }}><span className="whitespace-pre-wrap">{output.generated}</span></SpokenTurn>
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
    {linked && onReveal ? <Button label={result ? "View request" : "View result"} tone="ghost" block={false} reach onClick={() => onReveal(linked.key)} /> : result ? <p>Request details unavailable</p> : null}
  </div>;
}

/**
 * Recognized speech reads as your spoken turn: the amber mic mark, an outlined
 * bubble with a cursor while live recognition is still updating, and a dotted
 * underline only where a calibrated score is low. Restored text never shows as
 * still being recognized. Provider, timing and speaker evidence stay in the
 * details the turn opens (#3728), outside user-message and live-announcement
 * regions.
 */
export function ConversationRecognitionRow({ fragments, introduction = false }: { fragments: ConversationRecognition[]; introduction?: boolean }) {
  const first = fragments[0]!;
  const service = conversationService(first.providerId);
  const updating = fragments.filter(f => f.finalization === "interim").length;
  const finish = updating ? updating === fragments.length ? "updating" : "some-updating" : fragments.some(f => f.finalization === "final") ? "finished" : "unknown";
  const restored = fragments.some(f => f.restored);
  const moved = fragments.every(f => f.moved);
  return <section className="py-4 text-foreground" data-conversation-recognition="" style={{ overflowWrap: "anywhere" }}>
    {introduction && <div className="mb-3 text-xs text-muted-foreground">Voice · {service} <TranscriptSymbols /></div>}
    <SpokenTurn speaker="you" inProgress={!restored && !moved && updating > 0} details={{
      kind: "recognized", source: service, finish, unsaved: first.unsaved, restored, orderUnknown: fragments.some(f => f.orderUnknown), evidenceLabel: `Technical evidence (${fragments.length} fragment${fragments.length === 1 ? "" : "s"})`,
      children: <>
        <p>Recognized text evidence. Display order does not establish an exact response pairing.</p>
        <ol>{fragments.map(f => <li key={JSON.stringify([f.kind, f.sequence])} className="py-1">
          Epoch {f.epoch} · fragment {f.sequence} · {f.kind === "input_fragment" ? `Captured input ${f.utteranceId}; speaker unverified` : "Unassigned input; speaker unverified"}.
          {f.kind === "input_fragment" ? f.certainty === "known" && f.confidence !== undefined ? ` Service confidence ${Math.round(f.confidence * 100)}%.` : " No calibrated confidence." : ""}
          {f.kind === "unassigned_input_fragment" && f.sessionInterval ? ` Provider session timing; approximate: ${f.sessionInterval.startMs}–${f.sessionInterval.endMs} ms.` : f.kind === "input_fragment" && f.interval ? ` Provider input timing: ${f.interval.startMs}–${f.interval.endMs} ms.` : " Timing unavailable; speaker unverified."}
          {f.finalization === "final" ? " Service finish marker received." : f.finalization === "interim" ? " Updating recognition." : " No finish evidence."}
        </li>)}</ol>
      </>,
    }}><span className="whitespace-pre-wrap" data-recognized-text="">{moved ? "Moved to voice review" : fragments.map(f => <RecognizedWords key={JSON.stringify([f.kind, f.sequence])} fragment={f} />)}</span></SpokenTurn>
  </section>;
}

/**
 * The end divider's label: `Live`, then the retained duration (#3729). The
 * persona joins it once a conversation carries one (#3617); none is guessed.
 */
export function conversationEndLabel(durationMs?: number) {
  if (durationMs === undefined) return "Live";
  const total = Math.round(durationMs / 1000);
  const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, sec = String(total % 60).padStart(2, "0");
  return `Live · ${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${sec}`;
}
