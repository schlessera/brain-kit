import { useStore } from "zustand";
import { Button } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot } from "../../root-context.js";

/** Separate recognition evidence, never a captured-input or permission claim. */
export function ConversationUnassigned({ onReview }: { onReview: () => void }) {
  const root = useBrainUiRoot();
  const client = root.connection.conversation;
  const sessionId = useStore(root.stores.chat, s => s.activeSessionId);
  const fragments = useStore(client.state, s => s.unassigned);
  const pending = useStore(client.state, s => s.unassignedWork);
  if ((!fragments.length && !pending) || fragments.some(f => f.sessionId !== sessionId)) return null;
  return <section aria-label="Unassigned voice recognition" className="mx-auto max-h-64 w-full max-w-3xl shrink-0 overflow-y-auto border-t border-border py-2 text-sm text-foreground">
    <details>
      <summary className="min-h-11 cursor-pointer">Recognized speech · not sent to the agent</summary>
      <p className="my-2">Live speech can continue without an agent request. This text has no confirmed input association or completed-turn boundary.</p>
      <div className="max-h-32 overflow-y-auto whitespace-pre-wrap" data-unassigned-recognition="">
        {fragments.map(f => <span key={`${f.conversationId}:${f.epoch}:${f.sequence}`} title={`Session ${f.epoch}: ${f.sessionInterval.startMs}–${f.sessionInterval.endMs} ms`}>{f.text}</span>)}
      </div>
      <details className="my-2">
        <summary className="min-h-11 cursor-pointer">Fragment timings</summary>
        <ol className="max-h-24 overflow-y-auto text-xs">
          {fragments.map(f => <li key={`${f.conversationId}:${f.epoch}:${f.sequence}`}>Session {f.epoch}: {f.sessionInterval.startMs}–{f.sessionInterval.endMs} ms</li>)}
        </ol>
      </details>
      {!!pending && <p className="my-2">Voice requested agent work without an input association. No request was submitted or linked to running work.</p>}
      <Button label="Review in composer" disabled={!fragments.length} tone="ghost" block={false} onClick={() => { if (client.reviewUnassigned()) onReview(); }} />
      <p className="mt-1">Leaves voice and appends to voice review. Edit or send explicitly in the composer.</p>
    </details>
  </section>;
}
