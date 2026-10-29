import type { ConversationClientOutput } from "../../voice/conversation-client.js";
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
export function ConversationOutput({ output, restored = false }: { output: ConversationClientOutput; restored?: boolean }) {
  return <div className="py-4" data-conversation-output="" data-output-id={output.outputId}>
    <TurnHeader who="Brain" tone="brain" />
    <p className="whitespace-pre-wrap">{output.generated}</p>
    <p className="mt-2 text-xs text-muted-foreground">{restored ? "Restored generated speech · original discussion position unknown · " : "Generated speech · "}{output.playback === "played" ? "received audio chunks played; spoken portion unknown" : output.playback === "discarded" ? "rest of reply · not spoken" : "spoken portion unknown"}</p>
  </div>;
}

/** Exact host task/turn evidence, never a guessed association with recognized input. */
export function ConversationTaskContext({ message, sessionId }: { message: ChatMessage; sessionId: string | null }) {
  const root = useBrainUiRoot();
  const work = useStore(root.connection.conversation.state, s => s.work);
  const receipt = Object.values(work).find(w => w.provenance === "contextual" && w.sessionId === sessionId
    && ((message.turnId ?? message.streamTurnId) ? w.turnId === (message.turnId ?? message.streamTurnId) : !!message.requestId && w.requestId === message.requestId));
  if (!receipt) return null;
  return <details className="py-2 text-sm" data-conversation-task="">
    <summary className="min-h-11 cursor-pointer">Background task · {receipt.state}</summary>
    <p>Host task context · recognition may be uncertain. This is not a verified user quote.</p>
    <p className="whitespace-pre-wrap">{receipt.submitted}</p>
  </details>;
}
