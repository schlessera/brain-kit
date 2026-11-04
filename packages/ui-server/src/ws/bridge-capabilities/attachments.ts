import { createExtractor } from "../../attachments/extract.js";
import { createAttachmentReader, type AttachmentReader } from "../../attachments/read.js";
import type { BridgeContext, BridgeSlice } from "./context.js";
import type { TurnTranscript } from "./emission.js";

/** One attachment reader per host, so the extractor's concurrency bound is host-wide (#3154). */
const attachmentReaders = new WeakMap<object, AttachmentReader>();
function attachmentReaderOf(host: object): AttachmentReader {
  let reader = attachmentReaders.get(host);
  if (!reader) attachmentReaders.set(host, reader = createAttachmentReader(createExtractor()));
  return reader;
}

/**
 * Attachment reads (#3154): the session, principal and turn are this turn's;
 * the call names a file and a scope only. The budget is per turn.
 */
export function createAttachmentRead(ctx: Pick<BridgeContext, "host" | "turn" | "turnId" | "signal" | "backendId">,
  transcript: Pick<TurnTranscript, "collectedSessionId">): Partial<BridgeSlice<"readAttachment">> {
  const { host, turn, turnId, signal, backendId } = ctx;
  if (!host.drafts || !host.brainPath || (backendId !== "claude" && backendId !== "pi")) return {};
  const store = host.drafts, brainRoot = host.brainPath, reader = attachmentReaderOf(host), budget = { used: 0 };
  return { readAttachment: input => reader.read({ brainRoot, store, sessionId: transcript.collectedSessionId ?? turn.sessionId, turnId, signal, budget }, input) };
}
