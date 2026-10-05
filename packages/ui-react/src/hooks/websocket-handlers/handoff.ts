import type { ServerMessageHandlerMap } from "./types.js";

type HandoffFrame = "handoff_draft" | "handoff_receipt";

/**
 * Cross-backend handoff frames (#61). Both answer the review sheet that
 * asked: a draft names the summary run it belongs to, a receipt the review's
 * handoff key. A frame for a run or sheet that has since gone is dropped by
 * the store.
 */
export const handoffFrameHandlers = {
  handoff_draft: (msg, context) => {
    context.stores.handoff.getState().setDraft(msg.handoffId, {
      state: msg.state,
      ...(msg.text !== undefined ? { text: msg.text } : {}),
      ...(msg.message !== undefined ? { message: msg.message } : {}),
      ...(msg.costUsd !== undefined ? { costUsd: msg.costUsd } : {}),
      ...(msg.runId !== undefined ? { runId: msg.runId } : {}),
    });
  },
  handoff_receipt: (msg, context) => {
    context.stores.handoff.getState().noteReceipt(msg.handoffId, msg.state, msg.sessionId);
  },
} satisfies ServerMessageHandlerMap<HandoffFrame>;
