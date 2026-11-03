import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
import { restorationOf } from "../stores/chat-state.js";
import type { BrainUiServices } from "../root.js";

/**
 * How long a selected session may wait for its history before the view says
 * it could not be restored (#1328). Long enough for a slow backend to read a
 * long transcript; short enough that nobody waits on a spinner indefinitely.
 */
export const RESTORE_DEADLINE_MS = 20_000;

type SessionResume = Extract<ClientMessage, { type: "session_resume" }>;

/**
 * Restoring the selected session (#1328). A cold page / PWA relaunch keeps
 * only the stored session id, and opening a session whose buffer is gone
 * has no transcript either. Until the host's history for it arrives, the
 * view says it is restoring and nothing is sent into it. The request is
 * confirmed, not fire-and-forget: it is asked again on every new socket
 * until history arrives, and an unanswered one fails visibly after
 * RESTORE_DEADLINE_MS rather than waiting forever.
 */
export function createRestorationDriver(
  root: Pick<BrainUiServices, "stores">,
  deps: { send: (message: ClientMessage) => boolean; disposed: () => boolean },
) {
  /** The session_resume this socket sent for the selected session, while unanswered. */
  let restoreAsked: { sessionId: string; socket: number } | null = null;
  /** Counts connections, for `restoreAsked`: one request per socket. */
  let restoreSocket = 0;
  /** The deadline of the selected session's current restoration attempt. */
  let restoreAttempt: { sessionId: string; timer: ReturnType<typeof setTimeout> | null; idleRetried: boolean } | null = null;
  /** The phase the driver saw last, so Retry (failed → restoring) is told apart. */
  let lastRestoration: { sessionId: string; phase: "restoring" | "failed" } | null = null;

  function endAttempt(): void {
    if (restoreAttempt?.timer) clearTimeout(restoreAttempt.timer);
    restoreAttempt = null;
  }

  function startAttempt(sessionId: string): void {
    endAttempt();
    restoreAttempt = { sessionId, timer: null, idleRetried: false };
  }

  /**
   * The bound runs from a request that actually left, so a page that is
   * offline or locked reads as that, not as a failed restoration. A dropped
   * socket stops it; the next socket's request starts it again.
   */
  function armDeadline(sessionId: string): void {
    const attempt = restoreAttempt;
    if (attempt?.sessionId !== sessionId || attempt.timer) return;
    attempt.timer = setTimeout(() => {
      attempt.timer = null;
      if (deps.disposed() || restoreAttempt !== attempt) return;
      const restoration = restorationOf(root.stores.chat.getState());
      if (restoration?.sessionId !== sessionId || restoration.phase !== "restoring") return;
      root.stores.chat.getState().failRestore(sessionId, { reason: "timeout" });
    }, RESTORE_DEADLINE_MS);
  }

  function pauseDeadline(): void {
    if (restoreAttempt?.timer) clearTimeout(restoreAttempt.timer);
    if (restoreAttempt) restoreAttempt.timer = null;
  }

  function ask(sessionId: string): boolean {
    return deps.send({ type: "session_resume", sessionId });
  }

  /**
   * Keep the selected session's restoration moving; runs on every store
   * change. Retry is Chat clearing the failure (`clearRestoreFailure`): the
   * history is asked for again, under a new deadline. It reads only.
   */
  function drive(): void {
    if (deps.disposed()) return;
    const restoration = restorationOf(root.stores.chat.getState());
    const last = lastRestoration;
    lastRestoration = restoration && { sessionId: restoration.sessionId, phase: restoration.phase };
    if (!restoration) {
      endAttempt();
      restoreAsked = null;
      return;
    }
    const { sessionId } = restoration;
    const retried = restoration.phase === "restoring" && last?.sessionId === sessionId && last.phase === "failed";
    if (retried) {
      pauseDeadline();
      restoreAsked = null;
    }
    if (retried || restoreAttempt?.sessionId !== sessionId) startAttempt(sessionId);
    // Once per socket: a request a closed socket swallowed, or that never
    // left, is asked again on the next connection, also after a failure.
    // A failure keeps its request: only a new socket, or Retry, asks again.
    if (restoreAsked?.sessionId === sessionId && restoreAsked.socket === restoreSocket) return;
    ask(sessionId);
  }

  /**
   * An idle status for the selected session, or the host's unscoped greeting.
   * History for a resume arrives before its status, so a scoped idle while
   * the session is still unconfirmed means the history never came: ask once
   * more. The greeting only gets a request this socket has not sent yet.
   */
  function restoreIfNeeded(frameSessionId: string | null): void {
    const restoration = restorationOf(root.stores.chat.getState());
    if (!restoration || restoration.phase !== "restoring") return;
    if (frameSessionId === restoration.sessionId && restoreAttempt?.sessionId === restoration.sessionId && !restoreAttempt.idleRetried) {
      restoreAttempt.idleRetried = true;
      restoreAsked = null;
      ask(restoration.sessionId);
      return;
    }
    if (frameSessionId === null) drive();
  }

  /**
   * The outbound path for a `session_resume`. Opening a session asks for it,
   * and so does the restoration it starts: one request per socket is the
   * answer to both. Returns what the socket's own send returned.
   */
  function resume(msg: SessionResume, socketSend: (message: ClientMessage) => boolean): boolean {
    const restoring = restorationOf(root.stores.chat.getState())?.sessionId === msg.sessionId;
    if (restoring && restoreAsked?.sessionId === msg.sessionId && restoreAsked.socket === restoreSocket) return true;
    const sent = socketSend(msg);
    if (sent && restoring) {
      restoreAsked = { sessionId: msg.sessionId, socket: restoreSocket };
      armDeadline(msg.sessionId);
    }
    return sent;
  }

  /** Follow the chat and the socket; returns the unsubscribe. */
  function start(): () => void {
    const stops = [root.stores.chat.subscribe(drive), root.stores.connection.subscribe((s, prev) => {
      if (s.wsStatus === prev.wsStatus) return;
      if (s.wsStatus === "connected") restoreSocket++;
      else pauseDeadline();
      drive();
    })];
    return () => { for (const stop of stops.splice(0)) stop(); };
  }

  return {
    drive,
    restoreIfNeeded,
    resume,
    start,
    /** The socket closed: whatever it was asked is asked again on the next one. */
    socketClosed(): void { restoreAsked = null; },
    dispose: endAttempt,
  };
}

export type RestorationDriver = ReturnType<typeof createRestorationDriver>;
