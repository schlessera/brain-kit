/**
 * The socket a test client listens on (#4836): every frame the host sends,
 * parsed, in order.
 */
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { WSContext } from "../../src/ws/clients";

export function fakeClient() {
  const sent: ServerMessage[] = [];
  const ws: WSContext = { send: (data: string) => sent.push(JSON.parse(data) as ServerMessage) };
  /** The frames of one type that were sent, in order. */
  const frames = <T extends ServerMessage["type"]>(type: T) =>
    sent.filter((frame): frame is Extract<ServerMessage, { type: T }> => frame.type === type);
  return { ws, sent, frames };
}
