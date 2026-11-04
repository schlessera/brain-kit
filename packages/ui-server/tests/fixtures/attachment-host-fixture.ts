/**
 * The host half of `read_attachment` for the backend provider captures
 * (#3154): a real operational database, real stored originals sent into one
 * conversation, and the production reader and extractor. A backend probe's
 * bridge adapter calls `read` exactly as the ws bridge does, with this turn's
 * context and the call's parsed input only.
 */
import { join } from "node:path";
import type { AttachmentReadResult, ReadAttachmentInput } from "@schlessera/brain-ui-sdk/tool-contracts";
import { withChatFiles } from "../../src/attachments/context";
import { createExtractor } from "../../src/attachments/extract";
import { createAttachmentReader } from "../../src/attachments/read";
import { createUiDb } from "../../src/db/client";
import { createPrincipal } from "../../src/db/principals";
import { createDraftStore } from "../../src/drafts/store";
import { storeOriginal } from "../helpers/attachment-fixture";
import { ithacaPermitPdf, PERMIT_FACT } from "../helpers/odysseus-pdf";

export { PERMIT_FACT };
/** The fact only the voyage log's bytes state. */
export const LOG_FACT = "three oarsmen are carried back to the ships";
const VOYAGE_LOG = `Day 1: the fleet leaves Troy.\nDay 9: the lotus-eaters' island; ${LOG_FACT}.\n`;
/** The host's identity of the one conversation the originals were sent into. */
export const CONVERSATION = "voyage-ithaca";

export function fixtureAttachmentHost(brain: string, scratch: string) {
  const db = createUiDb(join(scratch, "attachments-ui.db"));
  const store = createDraftStore(db);
  const owner = createPrincipal(db, { authMethod: "password", label: "Odysseus phone", ttlSeconds: 3600 }).id;
  // An unknown extension and no MIME type: detection reads the bytes.
  const files = [storeOriginal(brain, store, owner, "draft-ithaca", "ithaca-permit.pdf", ithacaPermitPdf()),
    storeOriginal(brain, store, owner, "draft-ithaca", "voyage.log", VOYAGE_LOG)];
  store.save(owner, "draft-ithaca", { ifMatch: 0, idempotencyKey: "save", sessionId: null, text: "What does the permit allow?", attachmentIds: [], fileIds: files.map((f) => f.fileId) });
  store.accept({ draftRef: { draftId: "draft-ithaca", revision: 1 }, sessionId: CONVERSATION, resumed: false, requestId: "send", principalId: owner, fileIds: files.map((f) => f.fileId) });
  const reader = createAttachmentReader(createExtractor());
  return {
    permit: files[0]!, log: files[1]!,
    /** The first message exactly as the host sends it: the user's text and the reference block, no contents. */
    prompt: withChatFiles("What does the permit allow?", undefined, files),
    read: (turnId: string, signal: AbortSignal, budget: { used: number }, input: ReadAttachmentInput): Promise<AttachmentReadResult> =>
      reader.read({ brainRoot: brain, store, sessionId: CONVERSATION, turnId, signal, budget }, input),
    reads: () => store.attachmentReads(CONVERSATION).map((r) => [r.fileId, r.outcome]),
    close: () => db.close(),
  };
}
