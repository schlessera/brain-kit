import { ATTACHMENT_READS_CAPABILITY, type ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { sessionAttachmentReadsResponseSchema } from "@schlessera/brain-ui-sdk/schemas";
import type { BrainUiServices } from "../root.js";

/** How long one reads request may take before it counts as no answer. */
const READS_CALL_TIMEOUT_MS = 15_000;

/**
 * Delivers the host's attachment read records to the root's store (#3155,
 * #3589). A session's reads are fetched when its view opens and again after
 * each hello, since frames sent while the socket was down are gone; reads
 * recorded during a live turn arrive as `attachment_read` frames. Until a
 * session's answer arrives its sent rows claim nothing about reading.
 *
 * Reads only: nothing here sends a message or starts work.
 */
export function createAttachmentReadClient(root: Pick<BrainUiServices, "stores" | "apiBase" | "request">) {
  const store = root.stores.attachmentReads;
  let disposed = false;
  /** Bumped by every hello, so an answer from an older connection is dropped. */
  let epoch = 0;
  const inFlight = new Set<string>();

  async function load(sessionId: string): Promise<void> {
    if (disposed || !store.getState().supported || inFlight.has(sessionId)) return;
    const asked = epoch;
    inFlight.add(sessionId);
    try {
      const res = await root.request(`${root.apiBase()}/sessions/${encodeURIComponent(sessionId)}/attachment-reads`, {
        cache: "no-store",
        signal: AbortSignal.timeout(READS_CALL_TIMEOUT_MS),
      });
      if (!res.ok) return;
      const parsed = sessionAttachmentReadsResponseSchema.safeParse(await res.json().catch(() => undefined));
      if (!parsed.success || parsed.data.sessionId !== sessionId) return;
      if (disposed || asked !== epoch) return;
      store.getState().replace(sessionId, parsed.data.reads);
    } catch {
      // No answer: the rows keep claiming nothing, and the next view or hello asks again.
    } finally {
      inFlight.delete(sessionId);
    }
  }

  const active = () => root.stores.chat.getState().activeSessionId;
  const unsubscribe = root.stores.chat.subscribe((state, previous) => {
    const id = state.activeSessionId;
    if (id && id !== previous.activeSessionId && !store.getState().loaded[id]) void load(id);
  });

  return {
    hello(msg: Extract<ServerMessage, { type: "server_hello" }>): void {
      if (disposed) return;
      epoch++;
      store.getState().reset();
      store.getState().setSupported(msg.capabilities?.[ATTACHMENT_READS_CAPABILITY] === true);
      const id = active();
      if (id) void load(id);
    },
    frame(msg: ServerMessage): void {
      if (disposed || msg.type !== "attachment_read" || !store.getState().supported) return;
      store.getState().add(msg.sessionId, msg.read);
    },
    dispose(): void {
      disposed = true;
      unsubscribe();
      store.getState().reset();
    },
  };
}
