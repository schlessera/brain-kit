import type { ConversationHost } from "../conversation.js";
import type { ClientMessageHandler, ClientMessageOf, HandlerContext } from "./context.js";

type ConversationType =
  | "conversation_start"
  | "conversation_audio"
  | "conversation_endpoint"
  | "conversation_commit"
  | "conversation_playback"
  | "conversation_stop";

/**
 * Every live-conversation frame passes the same gate: nothing registers on a
 * closed connection, and a host without a conversation provider says so.
 */
function conversationFrame<K extends ConversationType>(
  run: (conversations: ConversationHost, ctx: HandlerContext, msg: ClientMessageOf<K>) => void | Promise<void>
): ClientMessageHandler<K> {
  return (ctx, msg) => {
    if (ctx.connection.closed) return;
    const conversations = ctx.host.conversations;
    if (!conversations) {
      ctx.host.sendMessage(ctx.ws, { type: "error", code: "CONVERSATION_UNAVAILABLE", message: "Live conversation is not configured on this host." });
      return;
    }
    return run(conversations, ctx, msg);
  };
}

export const handleConversationStart = conversationFrame<"conversation_start">(
  (conversations, { ws, connection }, msg) => conversations.start(ws, connection, msg)
);
export const handleConversationAudio = conversationFrame<"conversation_audio">(
  (conversations, { ws, connection }, msg) => conversations.audio(ws, connection, msg)
);
export const handleConversationEndpoint = conversationFrame<"conversation_endpoint">(
  (conversations, { ws, connection }, msg) => conversations.endpoint(ws, connection, msg)
);
export const handleConversationCommit = conversationFrame<"conversation_commit">(
  (conversations, { ws, connection }, msg) => conversations.commit(ws, connection, msg)
);
export const handleConversationPlayback = conversationFrame<"conversation_playback">(
  (conversations, { ws, connection }, msg) => conversations.playback(ws, connection, msg)
);
export const handleConversationStop = conversationFrame<"conversation_stop">(
  (conversations, { ws, connection }, msg) => conversations.stop(ws, connection, msg)
);
