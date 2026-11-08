import { cancelHandoffPreparation, handoffStatus, prepareHandoff } from "../handoff.js";
import type { ClientMessageHandler } from "./context.js";

// A `chat_message` carrying `handoff` starts one; see chat-message.ts.

export const handleHandoffStatus: ClientMessageHandler<"handoff_status"> = ({ host, ws }, msg) => {
  handoffStatus(host, ws, msg.handoffId);
};

export const handleHandoffPrepare: ClientMessageHandler<"handoff_prepare"> = async ({ host, ws, connection }, msg) => {
  if (connection.closed) return;
  await prepareHandoff(host, ws, msg, connection);
};

export const handleHandoffPrepareCancel: ClientMessageHandler<"handoff_prepare_cancel"> = ({ host, connection }, msg) => {
  cancelHandoffPreparation(host, msg.handoffId, connection);
};
