import { useStore } from "zustand";
import { Button } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot } from "../../root-context.js";

/** Optional transfer controls; readable recognition lives in the Chat timeline. */
export function ConversationUnassigned({ onReview }: { onReview: () => void }) {
  const root = useBrainUiRoot();
  const client = root.connection.conversation;
  const sessionId = useStore(root.stores.chat, s => s.activeSessionId);
  const retained = useStore(client.state, s => s.unassigned);
  const fragments = retained.filter(f => f.sessionId === sessionId);
  const pending = useStore(client.state, s => s.unassignedWork);
  if (!fragments.length && !pending) return null;
  return <section aria-label="Voice review controls" className="mx-auto w-full max-w-3xl shrink-0 border-t border-border py-2 text-xs text-foreground">
    <details>
      <summary className="min-h-11 cursor-pointer">Optional voice review</summary>
      {!!pending && <p className="my-2">Voice requested agent work without an input association. No request was submitted or linked to running work.</p>}
      <Button label="Review in composer" disabled={!fragments.length} tone="ghost" block={false} onClick={() => { if (client.reviewUnassigned()) onReview(); }} />
      <p className="mt-1">Leaves voice and moves retained recognition to voice review. This sends nothing. Permitted conversation tasks need no Send.</p>
    </details>
  </section>;
}
