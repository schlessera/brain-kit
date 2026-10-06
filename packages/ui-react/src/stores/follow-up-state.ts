import { createStore } from "zustand/vanilla";
import type {
  MessageSource,
  QueuedFollowUpView,
  ServerSessionQueue,
  SharedFileMeta,
  ThinkingLevel,
} from "@schlessera/brain-ui-sdk/protocol";
import type { MessageAttachment } from "./chat-state.js";

/**
 * Follow-ups the agent has not received yet, per session (#1002).
 *
 * A message sent while its session is busy is not drawn in the transcript
 * while it waits: it is a pill above the composer, and it enters the chat only
 * when its own turn starts, at that point in the conversation. What the host
 * reports (`session_queue`) is authoritative and rebuilt after every reload or
 * reconnect. A message this client has just sent is shown at once, as a local
 * entry, until the host's report includes it or refuses it.
 *
 * Held outside the transcript buffers: a history replace must not erase it,
 * and an evicted buffer must not lose it.
 */
export interface PendingFollowUp {
  /** The host's id, or `local:{requestId}` until the host reports it. */
  id: string;
  requestId?: string;
  text: string;
  attachmentCount?: number;
  fileCount?: number;
  source?: MessageSource;
  queuedAt: number;
  /** The host has reported it: it is persisted for as long as the host runs. */
  confirmed: boolean;
}

/** What this client sent, kept to draw its message exactly when it starts. */
export interface LocalFollowUp {
  requestId: string;
  text: string;
  source: MessageSource;
  attachments?: MessageAttachment[];
  files?: SharedFileMeta[];
  thinkingLevel?: ThinkingLevel;
  queuedAt: number;
}

/** One polite announcement for the pending group (D52 §3). */
export interface FollowUpAnnouncement {
  sessionId: string;
  text: string;
  /** Bumped per announcement, so the same words announce twice. */
  seq: number;
}

/** A follow-up that has just been handed to the agent, for the transcript. */
export interface StartedFollowUp {
  sessionId: string;
  turnId?: string;
  requestId?: string;
  text: string;
  source?: MessageSource;
  attachments?: MessageAttachment[];
  attachmentCount?: number;
  files?: SharedFileMeta[];
  /** Shared files the host counted; their metadata comes from the sender or history. */
  fileCount?: number;
  /** `text` is the host's shortened report of a longer message; history has it whole. */
  textTruncated?: boolean;
  thinkingLevel?: ThinkingLevel;
}

export interface FollowUpState {
  /** The host's last report per session, in send order. */
  reported: Record<string, QueuedFollowUpView[]>;
  /** Sent by this client and not yet reported, per session, in send order. */
  local: Record<string, LocalFollowUp[]>;
  /** Merged and ordered for display: reported first, then local. */
  pending: Record<string, PendingFollowUp[]>;
  announcement: FollowUpAnnouncement | null;
  /** Show a message this client just sent while its session was busy. */
  addLocal(sessionId: string, entry: LocalFollowUp): void;
  /**
   * Apply a host report. Returns the follow-up that started, with what this
   * client sent for it when it was the sender, so the transcript can draw it.
   */
  applyReport(frame: ServerSessionQueue): StartedFollowUp | null;
  /**
   * A turn started for a request this client is still showing as local: the
   * host ran it at once (the session had just gone idle). It is the agent's.
   */
  takeLocal(requestId: string): StartedFollowUp | null;
  /** The host refused, or never confirmed, a local entry: it is not pending. */
  dropLocal(requestId: string): void;
  /** A new connection: the host re-reports every queue after its hello. */
  reset(): void;
}

function merge(reported: QueuedFollowUpView[] = [], local: LocalFollowUp[] = []): PendingFollowUp[] {
  const known = new Set(reported.map((entry) => entry.requestId).filter(Boolean));
  // The host may report only the head of a long text; this client still has
  // the whole of what it sent.
  const sent = new Map(local.map((entry) => [entry.requestId, entry.text]));
  return [
    ...reported.map((entry) => {
      const whole = entry.requestId ? sent.get(entry.requestId) : undefined;
      if (whole === undefined) return { ...entry, confirmed: true };
      const { textTruncated: _shortened, ...rest } = entry;
      return { ...rest, text: whole, confirmed: true };
    }),
    ...local
      .filter((entry) => !known.has(entry.requestId))
      .map((entry) => ({
        id: `local:${entry.requestId}`,
        requestId: entry.requestId,
        text: entry.text,
        ...(entry.attachments?.length ? { attachmentCount: entry.attachments.length } : {}),
        ...(entry.files?.length ? { fileCount: entry.files.length } : {}),
        source: entry.source,
        queuedAt: entry.queuedAt,
        confirmed: false,
      })),
  ];
}

/**
 * Release the image previews of local entries that will never reach the
 * transcript. Once the host accepted a send, the composer let go of its
 * previews and only the entry holds them; a started entry hands them to its
 * transcript message instead, which the chat store releases.
 */
function releasePreviews(entries: readonly LocalFollowUp[]): void {
  for (const entry of entries) {
    for (const attachment of entry.attachments ?? []) {
      if (attachment.previewUrl.startsWith("blob:")) URL.revokeObjectURL(attachment.previewUrl);
    }
  }
}

function withSession<T>(map: Record<string, T[]>, sessionId: string, value: T[]): Record<string, T[]> {
  const next = { ...map };
  if (value.length) next[sessionId] = value;
  else delete next[sessionId];
  return next;
}

export function createFollowUpStore() {
  return createStore<FollowUpState>((set, get) => {
    let seq = 0;
    const announce = (sessionId: string, text: string): FollowUpAnnouncement => ({ sessionId, text, seq: ++seq });

    /** Write one session's lists and recompute its merged view. */
    const write = (
      sessionId: string,
      reported: QueuedFollowUpView[],
      local: LocalFollowUp[],
      announcement?: FollowUpAnnouncement
    ) => {
      const state = get();
      set({
        reported: withSession(state.reported, sessionId, reported),
        local: withSession(state.local, sessionId, local),
        pending: withSession(state.pending, sessionId, merge(reported, local)),
        ...(announcement ? { announcement } : {}),
      });
    };

    return {
      reported: {},
      local: {},
      pending: {},
      announcement: null,

      addLocal(sessionId, entry) {
        const state = get();
        const local = [...(state.local[sessionId] ?? []).filter((e) => e.requestId !== entry.requestId), entry];
        write(sessionId, state.reported[sessionId] ?? [], local, announce(sessionId, "Follow-up queued"));
      },

      applyReport(frame) {
        const state = get();
        const sessionId = frame.sessionId;
        const before = state.local[sessionId] ?? [];
        const leftIds = new Set(
          [frame.started?.requestId, ...(frame.dropped ?? []).map((entry) => entry.requestId)].filter(Boolean)
        );
        // A local entry is kept until the host starts or drops it: once the
        // host reports it the merge hides it, but its previews are still what
        // the transcript draws when it starts.
        const local = before.filter((entry) => !leftIds.has(entry.requestId));
        const droppedIds = new Set((frame.dropped ?? []).map((entry) => entry.requestId).filter(Boolean));
        releasePreviews(before.filter((entry) => droppedIds.has(entry.requestId)));
        const mine = frame.started?.requestId ? before.find((entry) => entry.requestId === frame.started!.requestId) : undefined;
        const wasShown = (requestId?: string, id?: string) =>
          (state.pending[sessionId] ?? []).some((entry) => (requestId && entry.requestId === requestId) || entry.id === id);
        const firstDrop = frame.dropped?.find((entry) => wasShown(entry.requestId, entry.id));
        const announcement = frame.started && wasShown(frame.started.requestId, frame.started.id)
          ? announce(sessionId, "Follow-up sent to the agent")
          : firstDrop
            ? announce(sessionId, `Follow-up dropped: ${firstDrop.reason}`)
            : undefined;
        write(sessionId, frame.followUps, local, announcement);
        if (!frame.started) return null;
        const started = frame.started;
        return {
          sessionId,
          turnId: started.turnId,
          ...(started.requestId ? { requestId: started.requestId } : {}),
          text: mine?.text ?? started.text,
          ...(started.source ? { source: started.source } : mine ? { source: mine.source } : {}),
          ...(mine?.attachments?.length ? { attachments: mine.attachments } : {}),
          ...(started.attachmentCount ? { attachmentCount: started.attachmentCount } : {}),
          ...(started.fileCount ? { fileCount: started.fileCount } : {}),
          ...(!mine && started.textTruncated ? { textTruncated: true } : {}),
          ...(mine?.files?.length ? { files: mine.files } : {}),
          ...(mine?.thinkingLevel !== undefined ? { thinkingLevel: mine.thinkingLevel } : {}),
        };
      },

      takeLocal(requestId) {
        const state = get();
        for (const [sessionId, entries] of Object.entries(state.local)) {
          const mine = entries.find((entry) => entry.requestId === requestId);
          if (!mine) continue;
          write(
            sessionId,
            state.reported[sessionId] ?? [],
            entries.filter((entry) => entry !== mine),
            announce(sessionId, "Follow-up sent to the agent")
          );
          return {
            sessionId,
            requestId,
            text: mine.text,
            source: mine.source,
            ...(mine.attachments?.length ? { attachments: mine.attachments } : {}),
            ...(mine.files?.length ? { files: mine.files } : {}),
            ...(mine.thinkingLevel !== undefined ? { thinkingLevel: mine.thinkingLevel } : {}),
          };
        }
        return null;
      },

      dropLocal(requestId) {
        const state = get();
        for (const [sessionId, entries] of Object.entries(state.local)) {
          if (!entries.some((entry) => entry.requestId === requestId)) continue;
          write(sessionId, state.reported[sessionId] ?? [], entries.filter((entry) => entry.requestId !== requestId));
        }
      },

      reset() {
        // An entry the host had reported was accepted, so its previews are the
        // entry's alone. One it never reported is still the composer's draft.
        const state = get();
        for (const [sessionId, entries] of Object.entries(state.local)) {
          const accepted = new Set((state.reported[sessionId] ?? []).map((entry) => entry.requestId));
          releasePreviews(entries.filter((entry) => accepted.has(entry.requestId)));
        }
        set({ reported: {}, local: {}, pending: {}, announcement: null });
      },
    };
  });
}
