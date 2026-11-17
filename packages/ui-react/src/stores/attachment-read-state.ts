import { createStore } from "zustand/vanilla";
import type { AttachmentReadEntry } from "@schlessera/brain-ui-sdk/protocol";

/**
 * What the agent read of each sent composer original, per session (#3155,
 * #3589). The host is the only source: a session's reads arrive from
 * `GET /api/sessions/:id/attachment-reads` when its view opens, and each
 * later read as one `attachment_read` frame. Nothing here is inferred from a
 * file's kind or reader, so a sent row says "read" only on a recorded read.
 *
 * Held outside the transcript buffers, like follow-ups: a history replace must
 * not erase reads, and an evicted buffer must not lose them.
 */
export interface AttachmentReadState {
  /** Whether this host delivers reads; without it a sent row claims nothing. */
  supported: boolean;
  /** sessionId → fileId → that file's recorded reads, oldest first. */
  reads: Record<string, Record<string, AttachmentReadEntry[]>>;
  /** Sessions whose route answer has arrived since the last hello. */
  loaded: Record<string, true>;
  setSupported(supported: boolean): void;
  /** The route's answer replaces what was known; frames that raced it are kept. */
  replace(sessionId: string, reads: AttachmentReadEntry[]): void;
  /** One frame: appended once, by its identity. */
  add(sessionId: string, read: AttachmentReadEntry): void;
  /** A new connection, principal or account: nothing known carries over. */
  reset(): void;
}

const same = (a: AttachmentReadEntry, b: AttachmentReadEntry) =>
  a.fileId === b.fileId && a.turnId === b.turnId && a.at === b.at && a.outcome === b.outcome;

function byFile(entries: AttachmentReadEntry[]): Record<string, AttachmentReadEntry[]> {
  const out: Record<string, AttachmentReadEntry[]> = {};
  for (const entry of [...entries].sort((a, b) => a.at - b.at)) (out[entry.fileId] ??= []).push(entry);
  return out;
}

export function createAttachmentReadStore() {
  return createStore<AttachmentReadState>()((set) => ({
    supported: false,
    reads: {},
    loaded: {},
    setSupported: (supported) => set((s) => (s.supported === supported ? s : { supported })),
    replace: (sessionId, entries) => set((s) => {
      const known = Object.values(s.reads[sessionId] ?? {}).flat();
      const merged = [...entries, ...known.filter((k) => !entries.some((e) => same(e, k)))];
      return { reads: { ...s.reads, [sessionId]: byFile(merged) }, loaded: { ...s.loaded, [sessionId]: true } };
    }),
    add: (sessionId, read) => set((s) => {
      const files = s.reads[sessionId] ?? {};
      const current = files[read.fileId] ?? [];
      if (current.some((e) => same(e, read))) return s;
      return { reads: { ...s.reads, [sessionId]: { ...files, [read.fileId]: [...current, read].sort((a, b) => a.at - b.at) } } };
    }),
    reset: () => set({ reads: {}, loaded: {} }),
  }));
}
