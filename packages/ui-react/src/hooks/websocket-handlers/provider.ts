import type { ServerMessageHandlerMap } from "./types.js";

type ProviderFrame = "session_info";

export const providerFrameHandlers = {
  session_info: (msg, context) => {
    context.ensureActivitySubscription(msg.sessionId);
    // Record backend ownership for renderer scoping — for ANY session, since
    // background sessions keep their own transcript buffers. Older servers
    // omit backendId; derive it from the pinned profile when still possible
    // (fails only for since-hidden profiles, which then use the default).
    const ownerBackendId =
      msg.backendId ??
      context.stores.provider
        .getState()
        .available.find((p) => p.id === msg.providerId)?.backendId;
    if (ownerBackendId) {
      context.stores.chat.getState().setSessionBackend(msg.sessionId, ownerBackendId);
    }
    // bindDraftSession in the dispatcher handled draft adoption; an info frame
    // may still re-pin the provider picker when it concerns the session in view.
    const current = context.stores.chat.getState();
    if (context.frameSessionId && context.frameSessionId === current.activeSessionId) {
      context.stores.provider.getState().setPinned(msg.providerId ?? null);
      // Reattachment on a fresh connection: enter streaming mode so deltas
      // append to a live assistant message instead of vanishing.
      const chat = current.buffers[context.frameSessionId];
      if (chat && !chat.isStreaming && chat.messages.length === 0) {
        current.startAssistantMessage(context.frameSessionId);
      }
    }
  },
} satisfies ServerMessageHandlerMap<ProviderFrame>;
