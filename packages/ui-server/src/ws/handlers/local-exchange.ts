import type { ClientMessageHandler } from "./context.js";

export const handleLocalExchange: ClientMessageHandler<"local_exchange"> = async ({ host, ws }, msg) => {
  const { catalog } = host;
  // A command the client answered itself (#582). Stored against the
  // session; the next prompt handed to the backend carries its context.
  // Answered either way, so the client can say when it is not kept.
  // Answered once it is stored (#2850); the next prompt takes it meanwhile.
  const saved = (await catalog.recordLocalExchange?.(msg.sessionId, msg.exchange, false)) ?? false;
  host.sendMessage(ws, {
    type: "local_exchange_result",
    sessionId: msg.sessionId,
    exchangeId: msg.exchange.id,
    saved,
    ...(saved
      ? {}
      : {
          reason: catalog.recordLocalExchange
            ? "The server could not store it."
            : "This server does not keep local answers.",
        }),
  });
};
