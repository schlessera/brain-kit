import type { DraftRef } from "@schlessera/brain-ui-sdk/protocol";

import type { WsHost } from "./host.js";

/**
 * Settle a chat message's draft at the moment the host accepted the message
 * (#979): its `session_info`, or its `status: queued`. Storage failure never
 * affects the turn; the draft simply stays, which loses nothing.
 */
export function acceptDraft(
  host: WsHost,
  input: { draftRef?: DraftRef; sessionId: string; resumed: boolean; requestId?: string; principalId: string }
): void {
  const { draftRef } = input;
  if (!host.drafts || !draftRef) return;
  try {
    host.drafts.accept({
      draftRef,
      sessionId: input.sessionId,
      resumed: input.resumed,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      principalId: input.principalId,
    });
  } catch {
    // Identity only: draft text and images never reach a log.
    host.log.emit({
      severityText: "WARN",
      body: "accepted message's draft could not be settled; it stays",
      attributes: { "session.id": input.sessionId },
    });
  }
}
