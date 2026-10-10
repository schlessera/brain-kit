import { EmptyState } from "@schlessera/brain-ui-kit";
import { restorationOf, useChatStore } from "../../stores/chat-store.js";

/**
 * The selected session's history has not arrived (#1328). A reload keeps
 * which conversation was open, not what it said, and until the host answers
 * the view must not read as a new chat: the next message would go into a
 * conversation whose earlier turns the reader cannot see. Restoring, then a
 * bounded failure with Retry and New chat; the draft stays where it is, and
 * nothing is sent when the history comes back.
 *
 * Renders nothing once the history is confirmed. Retry clears the failure,
 * and the connection, seeing the session restoring again, asks for its
 * history again under a new deadline.
 */
export function RestorationState({ onNewChat }: { onNewChat: () => void }) {
  const phase = useChatStore((s) => restorationOf(s)?.phase ?? null);
  const sessionId = useChatStore((s) => restorationOf(s)?.sessionId ?? null);
  // Retry clears the failure; the connection asks for the history again.
  const retry = useChatStore((s) => s.clearRestoreFailure);
  const reason = useChatStore((s) => {
    const restoration = restorationOf(s);
    return restoration?.phase === "failed" ? restoration.failure.reason : null;
  });
  if (phase === null) return null;
  return (
    <div role="status" aria-live="polite" data-restoration={phase} className="flex min-h-full items-center justify-center px-4 py-8">
      {phase === "restoring" ? (
        <EmptyState
          icon="history"
          tone="neutral"
          title="Restoring conversation"
          body="Loading its earlier messages. Sending waits until they are here; your draft is kept."
          meta=""
        />
      ) : (
        <EmptyState
          icon="failed"
          tone="red"
          title={"Couldn’t restore this conversation"}
          body={reason === "timeout"
            ? "Its earlier messages did not arrive. Sending stays paused so nothing goes into a conversation you cannot see; your draft is kept."
            : "The host could not load its earlier messages. Sending stays paused so nothing goes into a conversation you cannot see; your draft is kept."}
          meta=""
          primaryLabel="Retry"
          primaryIcon="retry"
          secondaryLabel="New chat"
          onPrimary={() => { if (sessionId) retry(sessionId); }}
          onSecondary={onNewChat}
        />
      )}
    </div>
  );
}
