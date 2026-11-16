/**
 * The server-frame handler map is keyed on the frames the SDK client hands its
 * consumer (#3389): exhaustive over them (`satisfies` in the map itself), and
 * with no `pong`, which the client consumes for liveness. `tsc --noEmit`
 * checks this file.
 */

import type { ConsumerServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { ServerMessageHandlerMap, ServerMessageType } from "../src/hooks/websocket-handlers/types.js";

type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

type HandlerMapDropsPong = Assert<Equal<Extract<ServerMessageType, "pong">, never>>;
type HandlerMapKeysEveryConsumerFrame = Assert<Equal<ServerMessageType, ConsumerServerMessage["type"]>>;

// @ts-expect-error A handler map cannot claim `pong`.
type PongEntry = ServerMessageHandlerMap<"pong">;

export type HandlerMapFrameAssertions = [HandlerMapDropsPong, HandlerMapKeysEveryConsumerFrame, PongEntry];
