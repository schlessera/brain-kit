import { useStore } from "zustand";
import { useBrainUiRoot } from "../../root-context.js";
import { TurnHeader } from "../chat/transcript-turn.js";

/** Voice-generated words share Chat's scrolling transcript; they never replace backend progress. */
export function ConversationOutputs({ sessionId }: { sessionId: string | null }) {
  const root = useBrainUiRoot();
  const outputs = useStore(root.connection.conversation.state, (state) => state.outputs);
  return <>{outputs.filter((output) => output.sessionId === sessionId && output.generated).map((output) =>
    <div key={`${output.conversationId}:${output.epoch}:${output.outputId}`} className="py-4" data-conversation-output="">
      <TurnHeader who="Brain" tone="brain" />
      <p className="whitespace-pre-wrap">{output.generated}</p>
      <p className="mt-2 text-xs text-muted-foreground">Generated speech · {output.playback === "played" ? "received audio chunks played; spoken portion unknown" : output.playback === "discarded" ? "rest of reply · not spoken" : "spoken portion unknown"}</p>
    </div>)}
  </>;
}
