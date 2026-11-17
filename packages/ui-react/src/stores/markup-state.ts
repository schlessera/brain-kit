import { createStore } from "zustand/vanilla";

/**
 * The open markup request (#3975), if any. Modal like the mask editor's, and
 * as short-lived: the layer is uploaded to the server, which writes the file
 * that persists; nothing here survives in a transcript.
 */
export interface MarkupRequest {
  requestId: string;
  imagePath: string;
  instruction?: string;
  /** The source's displayed size, read by the server; the layer matches it. */
  width: number;
  height: number;
  maxBytes: number;
  /** Relative to the API base. */
  uploadPath: string;
  /** Relative to the API base; read with the request's `turnId`. */
  sourcePath: string;
  turnId?: string;
}

export interface MarkupState {
  /** The request the editor shows: the oldest still open. */
  request: MarkupRequest | null;
  /**
   * Every open request, oldest first. A second request (another tool call or
   * session) waits behind the first instead of discarding its drawing; each
   * is answered or declined by its own id.
   */
  queue: MarkupRequest[];
  open: (request: MarkupRequest) => void;
  /** Close `requestId` only: an answer never closes another request. */
  close: (requestId?: string) => void;
}

export function createMarkupStore() {
  return createStore<MarkupState>((set, get) => {
    const settle = (queue: MarkupRequest[]) => set({ queue, request: queue[0] ?? null });
    return {
      request: null,
      queue: [],
      open: (request) => settle([...get().queue.filter((r) => r.requestId !== request.requestId), request]),
      close: (requestId) => settle(requestId === undefined ? get().queue.slice(1) : get().queue.filter((r) => r.requestId !== requestId)),
    };
  });
}
