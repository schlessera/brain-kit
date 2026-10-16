import { useStore } from "zustand";
import { useBrainUiRoot } from "../../root-context.js";
import { TurnHeader } from "../chat/transcript-turn.js";

/** Voice-generated words share Chat's scrolling transcript; they never replace backend progress. */
export function ConversationOutputs({ sessionId }: { sessionId: string | null }) {
  const root = useBrainUiRoot();
  const outputs = useStore(root.connection.conversation.state, (state) => state.outputs);
  const permission = useStore(root.connection.conversation.permissions.state);
  const buffer = useStore(root.stores.chat, state => sessionId === null ? state.draft : state.buffers[sessionId]);
  const tools = buffer?.messages.flatMap(m => m.toolCalls) ?? [];
  return <>{permission.records.filter(r => r.sessionId === sessionId && r.word && (r.postureDenied || r.heardAt && !tools.some(t => t.id === r.toolUseId))).map(r => <p key={`posture:${r.turnId}:${r.toolUseId}`} data-voice-posture-outcome={r.postureDenied ? "" : undefined} data-voice-permission-outcome="" className="py-2 text-xs">{r.word}</p>)}{outputs.filter((output) => output.sessionId === sessionId && output.generated).map((output) =>
    <div key={`${output.conversationId}:${output.epoch}:${output.outputId}`} className="py-4" data-conversation-output="">
      <TurnHeader who="Brain" tone="brain" />
      <p className="whitespace-pre-wrap">{output.generated}</p>
      <p className="mt-2 text-xs text-muted-foreground">Generated speech · {output.playback === "played" ? "received audio chunks played; spoken portion unknown" : output.playback === "discarded" ? "rest of reply · not spoken" : "spoken portion unknown"}</p>
    </div>)}
  </>;
}
