import { useStore } from "zustand";
import { Button, Callout } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot } from "../../root-context.js";

/** Optional transfer controls; readable recognition lives in the Chat timeline. */
export function ConversationUnassigned({ onReview }: { onReview: () => void }) {
  const root = useBrainUiRoot();
  const client = root.connection.conversation;
  const sessionId = useStore(root.stores.chat, s => s.activeSessionId);
  const retained = useStore(client.state, s => s.unassigned);
  const fragments = retained.filter(f => !f.taskContext && f.sessionId === sessionId);
  const pending = useStore(client.state, s => s.unassignedWork);
  if (!fragments.length && !pending) return null;
  // An optional control that exists because something happened is an inline
  // notice with its action, not a collapsible (#3253).
  const count = fragments.length;
  const situation = count
    ? `${count} voice ${count === 1 ? "fragment wasn't" : "fragments weren't"} sent. Review in composer leaves voice and moves the recognition to voice review; nothing is sent until you press Send. Permitted conversation tasks need no Send.`
    : "Voice requested agent work without an input association.";
  return <section aria-label="Voice review controls" className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-2 border-t border-border py-2 text-xs text-foreground">
    <Callout variant="boxed" tone="neutral" icon="mic">
      <span className="block">{situation}</span>
      {!!pending && <span className="mt-1 block">{count ? "Voice also requested agent work without an input association. " : ""}No request was submitted or linked to running work.</span>}
    </Callout>
    <Button label="Review in composer" disabled={!count} tone="ghost" block={false} onClick={() => { if (client.reviewUnassigned()) onReview(); }} />
  </section>;
}
