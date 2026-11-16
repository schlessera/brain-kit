/**
 * `pong` is the client's own frame (#3389). `BrainUiClient` answers its
 * liveness probes and returns before any consumer handler runs, so the
 * consumer-facing union and the handler type leave it out, while the wire
 * union the parser validates keeps it. `tsc --noEmit` checks this file.
 */

import type { ServerFrameHandlers } from "../src/client/index.js";
import type { ConsumerServerMessage, ServerMessage, ServerPong } from "../src/protocol.js";
import type { parseServerMessage } from "../src/schemas.js";
import type { Assert, Equal } from "./type-equality.js";

type ParsedFrame = Extract<ReturnType<typeof parseServerMessage>, { ok: true }>["message"];

// The parser still accepts a wire `pong`.
type ParserKeepsPong = Assert<Equal<Extract<ParsedFrame, { type: "pong" }>, ServerPong>>;
type WireUnionKeepsPong = Assert<Equal<Extract<ServerMessage, { type: "pong" }>, ServerPong>>;

// The consumer never receives one, and loses nothing else.
type ConsumerUnionDropsPong = Assert<Equal<Extract<ConsumerServerMessage["type"], "pong">, never>>;
type ConsumerUnionIsTheRest = Assert<Equal<ConsumerServerMessage | ServerPong, ServerMessage>>;

const handlers: ServerFrameHandlers = {
  // @ts-expect-error A consumer `pong` handler is no longer accepted.
  pong: () => {},
};

const anyFrame: ServerFrameHandlers = {
  onAny: (frame) => {
    // @ts-expect-error `onAny` never sees a `pong` either: the comparison has no overlap.
    if (frame.type === "pong") return;
  },
};

export type ConsumerFrameAssertions = [
  ParserKeepsPong, WireUnionKeepsPong, ConsumerUnionDropsPong, ConsumerUnionIsTheRest,
];
export { handlers, anyFrame };
