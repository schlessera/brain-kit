import { replyToToolApproval } from "../../lib/tool-approval.js";
import type { AskUserFormAnswers } from "@schlessera/brain-ui-sdk/protocol";
import { useBrainUiRoot } from "../../root-context.js";
import { Fragment, useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { ChevronUp } from "lucide-react";
import { useChatStore, activeChat } from "../../stores/chat-store.js";
import type { AskUserAnnotation } from "@schlessera/brain-ui-sdk/protocol";
import type { AnswerPayload } from "../../lib/answer-delivery/types.js";
import { useUIStore } from "../../stores/ui-store.js";
import { useWebSocket } from "../../hooks/use-websocket.js";
import { useTrackerSeen } from "../../hooks/use-tracker-seen.js";
import { MaskEditor } from "../images/mask-editor.js";
import { MessageBubble } from "./message-bubble.js";
import { useWorkRestore } from "../../hooks/use-local-work.js";
import { messageFingerprint } from "../../lib/local-work.js";

/** How long a restored transcript position is held against late layout (#1014). */
const RESTORE_HOLD_MS = 1_500;
import { WelcomeState } from "./welcome-state.js";
import { SessionDrawer } from "./session-drawer.js";
import { SubagentView } from "./subagent-view.js";
import { DigestCard } from "../activity/digest-card.js";
import { SettingsPanel } from "../settings/settings-panel.js";
import { StreamingPanel } from "../quick-actions/streaming-modal.js";
import { WhatsupPanel } from "../quick-actions/whatsup-modal.js";
import { SearchPanel } from "../quick-actions/search-modal.js";
import { AddPanel } from "../quick-actions/add-modal.js";
import { FilePanel } from "../files/file-panel.js";
import { Composer, type ComposerHandle } from "./composer.js";
import { ChatComposerRow } from "./composer-row.js";
import { sendReask } from "./reask-send.js";
import { HandoffSheet } from "./handoff-sheet.js";
import { HandoffMarker } from "./handoff-links.js";
import { useHandoffStore, type HandoffLink } from "../../stores/handoff-store.js";
import { markerPosition } from "../../lib/handoff.js";
import type { ChatMessage } from "../../stores/chat-state.js";
import { useChatCommands } from "./use-chat-commands.js";
import { useConnectionStore } from "../../stores/connection-store.js";
import { useMediaQuery } from "../../hooks/use-media-query.js";
import { Button, DiscButton, DiscRow } from "@schlessera/brain-ui-kit";
import { useRootStore } from "../../root-context.js";
import { SessionsPane } from "./sessions-pane.js";
import { UnconfirmedSends } from "./unconfirmed-sends.js";
import { trackerLabel, useWorkingSessions } from "../../hooks/use-working-sessions.js";
import { announcementText } from "../../lib/tracker-announcer.js";
import type { TrackerState } from "../../lib/trackers.js";
import { useDestinationPress } from "../../hooks/use-destination-press.js";
import { FIRST_CONTROL, focusFirst, openModal } from "../../lib/destination-start.js";
import {
  primeClientEnvironment,
  READING_COLUMN_ATTR,
} from "../../lib/client-environment.js";

/**
 * How much of a long transcript is rendered at once, and how much more each
 * "show earlier" reveals.
 *
 * The transcript is the one part of this app with no natural size limit: a
 * resumed session can replay hundreds of messages, and every one of them is a
 * parsed markdown tree that the browser then has to lay out and keep. Rendering
 * a window instead bounds the DOM without a virtualiser — messages are wildly
 * variable in height, and estimating that is where virtualisers get scroll
 * position wrong.
 */
const WINDOW_SIZE = 40;

const NO_LINKS: HandoffLink[] = [];

/**
 * After how many messages a forward marker sits: after the turn where the
 * source stood when it was handed off, so it keeps its place as the source
 * continues; at the end when that is unknown.
 */
function markerAfter(link: HandoffLink, messages: readonly ChatMessage[]): number {
  return markerPosition(messages, link.afterTurns);
}
const WINDOW_STEP = 40;

/**
 * How long opening a tracked session waits for its replayed history, and
 * for the card it is waiting on, before moving focus with what is drawn.
 */
const OPEN_CARD_WAIT_MS = 5_000;

/** A replayed history is complete once this long passes with no further chunk. */
const REPLAY_QUIET_MS = 150;

/** Tracker states that only `Mark as seen` can clear when the latest turn is not linked (R1). */
const UNPROVABLE: ReadonlySet<TrackerState> = new Set<TrackerState>(["done", "failed", "cancelled", "unknown", "cant_check"]);

/**
 * The chat surface: transcript, panels, and the composer.
 *
 * This component holds transcript-scale state only. The draft lives one level
 * down in <Composer>, so a keystroke never reaches the message list — see the
 * note there. Every callback handed to a message is wrapped in useCallback for
 * the same reason: MessageBubble is memoized, and an unstable prop would undo
 * that on the first re-render.
 */
export function ChatPage() {
  const root = useBrainUiRoot();
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const { send } = useWebSocket();

  const messages = useChatStore((s) => activeChat(s).messages);
  const sessionId = useChatStore((s) => s.activeSessionId);
  const clearMessages = useChatStore((s) => s.clearMessages);
  const setActiveSession = useChatStore((s) => s.setActiveSession);

  const sessionPanelOpen = useUIStore((s) => s.sessionPanelOpen);
  const setSessionPanelOpen = useUIStore((s) => s.setSessionPanelOpen);
  const subagentStack = useUIStore((s) => s.subagentStack);
  const syncPanelOpen = useUIStore((s) => s.syncPanelOpen);
  const setSyncPanelOpen = useUIStore((s) => s.setSyncPanelOpen);
  const whatsupPanelOpen = useUIStore((s) => s.whatsupPanelOpen);
  const setWhatsupPanelOpen = useUIStore((s) => s.setWhatsupPanelOpen);
  const searchPanelOpen = useUIStore((s) => s.searchPanelOpen);
  const setSearchPanelOpen = useUIStore((s) => s.setSearchPanelOpen);
  const addPanelOpen = useUIStore((s) => s.addPanelOpen);
  const setAddPanelOpen = useUIStore((s) => s.setAddPanelOpen);
  const filePanelOpen = useUIStore((s) => s.filePanelOpen);
  const setFilePanelOpen = useUIStore((s) => s.setFilePanelOpen);
  const settingsPanelOpen = useUIStore((s) => s.settingsPanelOpen);
  const setSettingsPanelOpen = useUIStore((s) => s.setSettingsPanelOpen);

  const runCommand = useChatCommands();
  // The phone Search disc is drawn only below `tablet:` (480px), where no
  // rail carries Search (D52 §8).
  const phone = !useMediaQuery("(min-width: 480px)");
  // From 1280 Sessions is a pane beside the transcript, not a drawer, and
  // the trackers live in it rather than in pills above the composer (D52 §1,
  // §3, §8). There is no New chat disc: the pane's New conversation is it.
  const wide = useMediaQuery("(min-width: 1280px)");
  // A Sessions drawer opened at this width (rail, ⌘2, the palette, or a
  // window widened past 1280 with it open) is answered by the pane, before
  // anything paints: the drawer closes and focus moves into the pane.
  useLayoutEffect(() => {
    if (wide && sessionPanelOpen) root.stores.ui.getState().focusSessionsPane();
  }, [wide, sessionPanelOpen, root]);
  // The welcome briefing chip's printed reason, the same one the palette and
  // More print: offline first, then a running turn.
  const connected = useConnectionStore((s) => s.wsStatus === "connected");
  const isStreaming = useChatStore((s) => activeChat(s).isStreaming);
  const briefingWhy = !connected ? "needs the host" : isStreaming ? "a turn is running" : undefined;

  // Handoff links (#61): the session list carries them; refresh them when
  // a stored session comes into view, so its card and markers can draw.
  const forward = useHandoffStore((s) => (sessionId ? s.forward[sessionId] : undefined)) ?? NO_LINKS;
  // The root's session list indexes them on every answer. It also names the
  // trackers, so a session tracked anew, or a tracked session's work moving
  // on, asks for the list again: #1004's host relabels a session when a turn
  // starts, and saves the label a moment later, so the end of the turn asks
  // once more.
  const trackedTurns = useRootStore("trackers", (s) => Object.values(s.records)
    .map((r) => `${r.sessionId}:${r.turnId ?? ""}:${s.evidence[r.sessionId]?.latest?.state ?? ""}`).sort().join("\n"));
  // So does the end of a turn in the session in view, whose cost, turn
  // count and place in the list the Sessions pane shows at every moment.
  const turnRunning = useChatStore((s) => activeChat(s).isStreaming);
  useEffect(() => {
    if (sessionId || trackedTurns) void root.stores.sessions.getState().refresh();
  }, [sessionId, trackedTurns, turnRunning, root]);

  // Only the tail of a long transcript is rendered; the rest is one tap away.
  const [visibleCount, setVisibleCount] = useState(WINDOW_SIZE);
  // Switching sessions starts a fresh window. Adjusted during render rather
  // than in an effect, so the new session never paints with the old window.
  const [windowedSession, setWindowedSession] = useState(sessionId);
  if (windowedSession !== sessionId) {
    setWindowedSession(sessionId);
    setVisibleCount(WINDOW_SIZE);
  }
  const hiddenCount = Math.max(0, messages.length - visibleCount);
  const visibleMessages = hiddenCount > 0 ? messages.slice(hiddenCount) : messages;

  // Revealing earlier messages prepends content, which would otherwise shove
  // the view down by the height of everything added. Remember the distance to
  // the BOTTOM across the change and restore it, so the message the user was
  // reading stays where it was.
  const scrollAnchorRef = useRef<number | null>(null);
  const showEarlier = useCallback(() => {
    const el = scrollRef.current;
    scrollAnchorRef.current = el ? el.scrollHeight - el.scrollTop : null;
    setVisibleCount((n) => n + WINDOW_STEP);
  }, []);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = scrollAnchorRef.current;
    if (el && anchor !== null) {
      el.scrollTop = el.scrollHeight - anchor;
      scrollAnchorRef.current = null;
    }
  });

  // Auto-scroll on new content when tailing is active
  useEffect(() => {
    const el = scrollRef.current;
    if (el && autoScrollRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  // Content that grows after it is committed (markdown that renders once
  // its parser has loaded, an image that has decoded) keeps a tailing
  // transcript at its latest turn too. Opening a tracked session relies on
  // it: the replayed history reaches its height a moment after the frame.
  const columnRef = useRef<HTMLDivElement>(null);
  const hasColumn = messages.length > 0;
  useEffect(() => {
    const column = columnRef.current;
    if (!column || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const el = scrollRef.current;
      if (el && autoScrollRef.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(column);
    return () => observer.disconnect();
  }, [hasColumn]);

  // Tray growth removes space from the bottom, never from the reading
  // target. Keep the previous scroll position if native anchoring moves it
  // during that resize; ordinary user scrolling still sets the new anchor.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const trayHeight = () => el.parentElement?.parentElement?.querySelector("[data-recordings-tray]")?.getBoundingClientRect().height ?? 0;
    let tray = trayHeight();
    let height = el.clientHeight;
    let top = el.scrollTop;
    const remember = () => { if (el.clientHeight === height) top = el.scrollTop; };
    const observer = new ResizeObserver(() => {
      const nextHeight = el.clientHeight;
      const nextTray = trayHeight();
      if (nextHeight < height && nextTray > tray) el.scrollTop = top;
      tray = nextTray;
      height = nextHeight;
      top = el.scrollTop;
    });
    el.addEventListener("scroll", remember, { passive: true });
    observer.observe(el);
    return () => { observer.disconnect(); el.removeEventListener("scroll", remember); };
  }, [hasColumn]);

  // Probe the device inventory once on mount so the FIRST message already
  // carries the camera/microphone facts (enumerateDevices is async).
  useEffect(() => {
    void primeClientEnvironment();
  }, []);

  // Scroll listener: disable tailing when user scrolls up, re-enable at bottom
  const hasMessages = messages.length > 0;
  const localWork = root.localWork;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const handleScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
      autoScrollRef.current = atBottom;
      setShowScrollButton(!atBottom);
      // Where the reader is goes into the work context kept on this device (#1014).
      localWork?.changed();
    };

    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [hasMessages, localWork]);

  // The transcript's place in each snapshot of the work context (#1014): the
  // first message in view, by its place in the transcript, and how far its
  // top sits from the transcript's top.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  useEffect(() => root.localWork?.register(() => {
    const el = scrollRef.current;
    if (!el) return { scroll: null };
    const top = el.getBoundingClientRect().top;
    for (const node of el.querySelectorAll<HTMLElement>("[data-transcript-anchor]")) {
      const box = node.getBoundingClientRect();
      if (box.bottom <= top) continue;
      const anchor = node.dataset.transcriptAnchor!;
      const message = messagesRef.current[Number(anchor)];
      return { scroll: { anchor, offset: box.top - top, ...(message ? { fingerprint: messageFingerprint(message) } : {}) } };
    }
    return { scroll: null };
  }), [root]);

  // After a reload, the transcript goes back to where it was read: once the
  // replayed history holds the anchor, it is brought into the window and
  // scrolled to its offset. The entrance motion and late layout move it for
  // a moment, so the offset is held for a short while, until the reader
  // scrolls.
  const pendingScroll = useWorkRestore((s) => s.scroll);
  const holdRef = useRef<(() => void) | null>(null);
  // Leaving the page, or opening another session, ends a hold.
  useEffect(() => () => { holdRef.current?.(); holdRef.current = null; }, [sessionId]);
  useEffect(() => {
    const work = root.localWork;
    const el = scrollRef.current;
    if (!work || !el || !pendingScroll || pendingScroll.sessionId !== sessionId) return;
    let ordinal = Number(pendingScroll.anchor);
    if (!Number.isInteger(ordinal) || ordinal < 0) { work.restore.setState({ scroll: null }); return; }
    if (messages.length <= ordinal && !pendingScroll.fingerprint) return;
    // The replay may hold other rows than the page did (a local exchange it
    // never kept): the place is checked against what was there, and the
    // message looked for nearby when it moved. Not found, nothing moves.
    const print = pendingScroll.fingerprint;
    if (print && (ordinal >= messages.length || messageFingerprint(messages[ordinal]!) !== print)) {
      const at = messages.map((m, i) => (messageFingerprint(m) === print ? i : -1)).filter((i) => i >= 0);
      if (at.length === 0) { if (messages.length > ordinal) work.restore.setState({ scroll: null }); return; }
      ordinal = at.reduce((a, b) => (Math.abs(b - ordinal) < Math.abs(a - ordinal) ? b : a));
    }
    if (ordinal < hiddenCount) { setVisibleCount(messages.length - ordinal); return; }
    work.restore.setState({ scroll: null });
    autoScrollRef.current = false;
    const offset = pendingScroll.offset;
    const until = performance.now() + RESTORE_HOLD_MS;
    let frame = 0;
    let stopped = false;
    const stop = () => {
      stopped = true;
      cancelAnimationFrame(frame);
      for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) el.removeEventListener(type, stop);
    };
    for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) el.addEventListener(type, stop, { passive: true });
    const hold = () => {
      if (stopped) return;
      const target = el.querySelector<HTMLElement>(`[data-transcript-anchor="${ordinal}"]`);
      if (target) {
        const delta = target.getBoundingClientRect().top - el.getBoundingClientRect().top - offset;
        if (Math.abs(delta) >= 0.5) el.scrollTop += delta;
      }
      if (performance.now() < until) frame = requestAnimationFrame(hold);
      else stop();
    };
    frame = requestAnimationFrame(hold);
    // Consuming the restore re-runs this effect; only leaving the page ends the hold early.
    holdRef.current?.();
    holdRef.current = stop;
  }, [root, pendingScroll, sessionId, messages, hiddenCount]);

  // A tracker for this session clears only once its latest turn is
  // actually on screen (D52 §4); selecting the session is not enough.
  useTrackerSeen(scrollRef, showScrollButton);

  // D52 R1: this session's tracker has a latest turn the replayed history
  // does not link (no message carries its host turn id), or the host cannot
  // say which turn is latest, so no observation can prove it seen. Only once
  // something has answered for it, and with nothing still in flight.
  const tracked = useWorkingSessions();
  const view = sessionId ? tracked.views.get(sessionId) : undefined;
  // Once its history has been replayed: an empty one is offered it too.
  const replayed = useChatStore((s) => (sessionId ? (s.historyLoads[sessionId] ?? 0) > 0 : false));
  const unlinked = !!view && view.settled && !view.cleared && !isStreaming && (replayed || messages.length > 0)
    && UNPROVABLE.has(view.state) && (view.turnId === null || messages.at(-1)?.turnId !== view.turnId);
  const markSeen = () => {
    if (!sessionId) return;
    root.stores.trackers.getState().acknowledge(sessionId);
    // The row goes with the tracker: focus goes where a press of Chat sends it.
    focusLatest(false);
  };

  const handleToolApproval = useCallback(
    (toolUseId: string, approved: boolean, always?: boolean) => {
      return replyToToolApproval(root, sessionId, send, toolUseId, approved, always);
    },
    [send, sessionId, root]
  );

  /**
   * Every ask answer goes to the answer queue (#910), never straight to the
   * socket: it is saved on this device first, and the card says "answered"
   * only when the host's receipt does. The binding is the exchange's own:
   * this session, and the turn its request frame named.
   */
  const submitAnswer = useCallback(
    (requestId: string, payload: AnswerPayload) => {
      const chat = root.stores.chat.getState();
      const buffer = sessionId === null ? chat.draft : chat.buffers[sessionId];
      const exchange = buffer?.messages
        .flatMap((m) => m.askUserExchanges ?? [])
        .find((e) => e.requestId === requestId);
      void root.answers.submit({
        requestId,
        sessionId,
        ...(exchange?.turnId ? { turnId: exchange.turnId } : {}),
        payload,
      });
    },
    [sessionId, root]
  );

  const handleAskUserSubmit = useCallback(
    (
      requestId: string,
      answers: Record<string, string>,
      annotations?: Record<string, AskUserAnnotation>
    ) => submitAnswer(requestId, { kind: "ask_user", answers, ...(annotations ? { annotations } : {}) }),
    [submitAnswer]
  );

  const handleAskUserListSubmit = useCallback(
    (requestId: string, answers: Record<string, string>, notes?: Record<string, string>) =>
      submitAnswer(requestId, { kind: "ask_user_list", answers, ...(notes ? { notes } : {}) }),
    [submitAnswer]
  );

  const handleAskUserRankSubmit = useCallback(
    (requestId: string, order: string[], unchanged: boolean) =>
      submitAnswer(requestId, { kind: "ask_user_rank", order, unchanged }),
    [submitAnswer]
  );

  const handleAskUserFormSubmit = useCallback(
    (requestId: string, answers: AskUserFormAnswers, visibleNodes: string[]) =>
      submitAnswer(requestId, { kind: "ask_user_form", answers, visibleNodes }),
    [submitAnswer]
  );

  const handleAskUserCancel = useCallback(
    (requestId: string) => {
      root.stores.chat.getState().cancelAskUser(sessionId, requestId);
      root.answers.dismissed(requestId);
      send({ type: "ask_user_cancel", requestId, reason: "User dismissed" });
    },
    [send, sessionId, root]
  );

  /** A dismissed question asked again (seventh drop, ruling 7). */
  const handleAskUserReask = useCallback(
    (text: string) => sendReask(root.stores, sessionId, text, send),
    [send, sessionId, root]
  );

  const handleSessionResume = useCallback(
    (resumeSessionId: string) => {
      clearMessages();
      setActiveSession(resumeSessionId);
      send({ type: "session_resume", sessionId: resumeSessionId });
    },
    [send, clearMessages, setActiveSession]
  );

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      autoScrollRef.current = true;
      setShowScrollButton(false);
    }
  }, []);

  /**
   * Pressing Chat while it is shown (D52 N3, as its addendum amends it for
   * Chat). Its start is the latest turn, so an occupied transcript does what
   * `Scroll to latest` does, with the same window; the empty chat's welcome
   * goes to its top. Focus goes to a waiting approval or question's first
   * control, then the latest turn's failure's primary action, then the
   * composer with the caret at the end. On a phone the composer is skipped
   * and focus stays on the Chat tab, so the soft keyboard does not open.
   */
  const areaRef = useRef<HTMLDivElement>(null);
  const welcomeRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ComposerHandle>(null);
  /**
   * Focus for the latest turn, shared by a press of Chat (N3) and opening a
   * tracked session (D52 §4): a waiting approval or question's first
   * control, then the latest turn's failure's primary action, then, from
   * 480 up, the composer with the caret at the end. On a phone nothing
   * else takes focus, so the soft keyboard does not open. Never out of an
   * open modal. Returns whether something took focus.
   */
  const focusLatest = (keyboard: boolean): boolean => {
    const area = areaRef.current;
    const waiting = area?.querySelector<HTMLElement>("[data-approval-card], [data-ask-waiting]");
    const latest = root.stores.chat.getState();
    const failed = activeChat(latest).messages.at(-1)?.failure
      ? [...(area?.querySelectorAll<HTMLElement>("[data-turn-failure]") ?? [])].at(-1)
      : undefined;
    if (focusFirst([
      (waiting?.querySelector<HTMLElement>("[data-kit-approval-actions]") ?? waiting)?.querySelector<HTMLElement>(FIRST_CONTROL),
      failed?.querySelector<HTMLElement>(".bk-turn-error-actions [data-bk-button]"),
    ], keyboard)) return true;
    if (phone || openModal()) return false;
    return composerRef.current?.focusEnd() ?? false;
  };
  useDestinationPress("chat", ({ keyboard }) => {
    if (scrollRef.current) scrollToBottom();
    else welcomeRef.current?.scrollTo({ top: 0, behavior: "instant" });
    if (focusLatest(keyboard) || phone || openModal()) return;
    if (!hasMessages) focusFirst([welcomeRef.current?.querySelector<HTMLElement>('[role="heading"]')], keyboard);
  });

  /**
   * Opening a tracked session (D52 §4), from a pill, the Working sheet or a
   * Working row: the session is reattached by the same `session_resume` a
   * session row sends, which starts no turn, and once its history has been
   * replayed the transcript goes to its latest turn and focus moves as
   * `focusLatest` rules. A tracker that waits on the reader also waits for
   * its card, which the host re-delivers after the history, for a few
   * seconds at most. Opening the session already in view replays nothing.
   *
   * Opening clears nothing: the seen observer does, once the latest turn is
   * on screen (`useTrackerSeen`).
   */
  const opening = useRef<{ sessionId: string; loads: number; card: boolean; until: number; seen: number; seenAt: number } | null>(null);
  const openingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, setOpeningTick] = useState(0);
  const openTracker = useCallback((id: string) => {
    const chat = root.stores.chat.getState();
    const evidence = root.stores.trackers.getState().evidence[id];
    const resume = chat.activeSessionId !== id;
    const loads = chat.historyLoads[id] ?? 0;
    opening.current = {
      sessionId: id,
      loads: resume ? loads : -1,
      card: (evidence?.pending.length ?? 0) > 0,
      until: Date.now() + OPEN_CARD_WAIT_MS,
      seen: loads,
      seenAt: Date.now(),
    };
    root.stores.ui.getState().setActiveView("chat");
    if (resume) handleSessionResume(id);
    setOpeningTick((n) => n + 1);
  }, [root, handleSessionResume]);
  useEffect(() => {
    const intent = opening.current;
    if (!intent) return;
    const chat = root.stores.chat.getState();
    const ui = root.stores.ui.getState();
    // The reader went somewhere else first, or opened something over Chat:
    // nothing is owed, and focus is not taken from where they went.
    const covered = ui.activeView !== "chat" || ui.sessionPanelOpen || ui.filePanelOpen || ui.settingsPanelOpen || ui.syncPanelOpen
      || ui.whatsupPanelOpen || ui.searchPanelOpen || ui.addPanelOpen || ui.paletteOpen || ui.subagentStack.length > 0
      // The other surfaces over Chat, as the seen observer lists them.
      || root.stores.mask.getState().request !== null || root.stores.handoff.getState().sheet !== null;
    if (chat.activeSessionId !== intent.sessionId || covered) { opening.current = null; return; }
    // A long history arrives in several chunks, back to back: the replay is
    // over once a chunk has come and no other has followed it for a moment.
    const now = Date.now();
    const loads = chat.historyLoads[intent.sessionId] ?? 0;
    if (loads !== intent.seen) { intent.seen = loads; intent.seenAt = now; }
    const replayed = intent.loads < 0 || (loads > intent.loads && now - intent.seenAt >= REPLAY_QUIET_MS);
    const card = areaRef.current?.querySelector("[data-approval-card], [data-ask-waiting]");
    const left = intent.until - now;
    if (left > 0 && (!replayed || (intent.card && !card))) {
      if (openingTimer.current) clearTimeout(openingTimer.current);
      openingTimer.current = setTimeout(() => setOpeningTick((n) => n + 1), Math.min(left, REPLAY_QUIET_MS));
      return;
    }
    opening.current = null;
    if (scrollRef.current) scrollToBottom();
    focusLatest(false);
  });
  useEffect(() => () => { if (openingTimer.current) clearTimeout(openingTimer.current); }, []);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Mask editor: modal, mounted here because it answers over the socket
          this page owns. Renders nothing unless the agent has asked. */}
      <MaskEditor
        onSubmit={(requestId, maskPng) => send({ type: "mask_response", requestId, maskPng })}
        onCancel={(requestId, message) =>
          send({ type: "mask_error", requestId, code: "cancelled", message })
        }
      />

      {/* Subagent drill-in: an overlay stack — chat is the residence, the
          drill-in opens over it and backs out level by level. */}
      {subagentStack.length > 0 && (
        <div className="fixed inset-0 z-40 bg-background">
          <SubagentView
            spanId={subagentStack[subagentStack.length - 1]!}
            onApproval={handleToolApproval}
          />
        </div>
      )}

      {/* Panels */}
      <SessionDrawer
        open={sessionPanelOpen && !wide}
        onClose={() => setSessionPanelOpen(false)}
        onResume={handleSessionResume}
        onOpenTracker={openTracker}
      />
      <TrackerAnnouncer />
      <SettingsPanel
        open={settingsPanelOpen}
        onClose={() => setSettingsPanelOpen(false)}
      />
      <StreamingPanel
        open={syncPanelOpen}
        onClose={() => setSyncPanelOpen(false)}
        title="Brain Sync"
        endpoint="/api/brain/sync"
      />
      <WhatsupPanel
        open={whatsupPanelOpen}
        onClose={() => setWhatsupPanelOpen(false)}
      />
      <SearchPanel
        open={searchPanelOpen}
        onClose={() => setSearchPanelOpen(false)}
      />
      <AddPanel
        open={addPanelOpen}
        onClose={() => setAddPanelOpen(false)}
      />
      <FilePanel
        open={filePanelOpen}
        onClose={() => setFilePanelOpen(false)}
      />

      {/* From 1280 the Sessions pane sits beside the transcript, first in
          DOM order so Tab goes rail → pane → transcript → composer (D52 §8). */}
      <div className="flex flex-1 overflow-hidden">
        {wide && <SessionsPane empty={!hasMessages} onResume={handleSessionResume} onOpenTracker={openTracker} />}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Message area. A size container, so the transcript can tell whether
              its reading column clears the New chat disc (below). */}
          <div ref={areaRef} className="@container relative flex-1 overflow-hidden">
            {/* New chat is the Chat header's primary action (D37): a tab is a
                place and starting a chat is an act, so it is neither a rail row
                nor a bar slot. It only appears once there is a conversation to
                leave. Drawn over the transcript rather than in a row above it, so
                the transcript keeps that height (#93), and first in the area so
                Tab reaches it before the messages.

                The kit's overlay disc (D52 §7): a 32px paint in a 44px button
                that reaches 12px left and 6px up and down, and not right, so it
                never sits over a classic scrollbar. Ink at rest as the primary
                act; hover and keyboard focus open the pill leftward. There is no
                confirmation: every session keeps its own draft (D52 §5).

                Below 480 the phone Search disc sits left of it, muted as the
                secondary act, so Search is one tap from occupied Chat (D52 §2).
                It comes first in DOM and tab order. The row is right-anchored,
                so New chat's pill pushes Search leftward and never covers it.
                The empty chat has its Search chip instead.

                From 1280 neither is drawn: the Sessions pane's New conversation
                is New chat there, and the rail carries Search (D52 §1). */}
            {hasMessages && !wide && (
              <DiscRow label="Chat actions" style={{ position: "absolute", right: 16, top: 10, zIndex: 10 }}>
                {phone && (
                  <DiscButton name="Search the brain" icon="search" tone="mute" label="Search" onClick={() => runCommand("search")} />
                )}
                <DiscButton name="New chat" icon="compose" tone="ink" label="New chat" onClick={clearMessages} />
              </DiscRow>
            )}
            {messages.length === 0 ? (
              <div ref={welcomeRef} className="h-full overflow-y-auto" data-welcome="">
                <div className="px-4 pt-3 md:px-6">
                  <DigestCard />
                </div>
                {/* A tracked session whose history came back empty can still be acknowledged. */}
                {unlinked && <MarkAsSeen onMark={markSeen} />}
                <div className="px-4 md:px-6"><div className="mx-auto max-w-3xl"><UnconfirmedSends /></div></div>
                <WelcomeState onAction={runCommand} briefingWhy={briefingWhy} />
              </div>
            ) : (
              // The top padding keeps the resting first message's text below the
              // New chat target (54px down; a message pads its own 16px). From
              // 888px the 768px column is centred clear of the target's 60px, so
              // the padding goes. It scrolls away with the content either way.
              <div ref={scrollRef} className="h-full overflow-y-auto px-4 pt-10 md:px-6 @min-[888px]:pt-0">
                {/* Tagged so the client-environment probe reports the width text
                    actually renders into, not the whole window. */}
                <div
                  ref={columnRef}
                  {...{ [READING_COLUMN_ATTR]: "" }}
                  className="mx-auto max-w-3xl divide-y divide-border/20"
                >
                  {hiddenCount > 0 && (
                    <div className="flex justify-center py-3">
                      <button
                        type="button"
                        onClick={showEarlier}
                        className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <ChevronUp className="h-3.5 w-3.5" />
                        Show {Math.min(hiddenCount, WINDOW_STEP)} earlier message
                        {Math.min(hiddenCount, WINDOW_STEP) === 1 ? "" : "s"}
                        <span className="text-muted-foreground/50">
                          ({hiddenCount} hidden)
                        </span>
                      </button>
                    </div>
                  )}
                  {visibleMessages.map((msg, index) => (
                    <Fragment key={msg.id}>
                      <MessageBubble
                        message={msg}
                        onToolApproval={handleToolApproval}
                        onAskUserSubmit={handleAskUserSubmit}
                        onAskUserCancel={handleAskUserCancel}
                        onAskUserReask={handleAskUserReask}
                        onAskUserListSubmit={handleAskUserListSubmit}
                        onAskUserRankSubmit={handleAskUserRankSubmit}
                        onAskUserFormSubmit={handleAskUserFormSubmit}
                        closing={msg === messages[messages.length - 1]}
                        anchor={String(hiddenCount + index)}
                      />
                      {/* Where this conversation was continued elsewhere (#61). */}
                      {forward
                        .filter((link) => markerAfter(link, messages) === hiddenCount + index + 1)
                        .map((link) => <HandoffMarker key={link.sessionId} sessionId={link.sessionId} backendId={link.backendId} title={link.title} />)}
                    </Fragment>
                  ))}
                  {unlinked && <MarkAsSeen onMark={markSeen} />}
                  {/* A send the host never confirmed, held where it was sent (D52 §5). */}
                  <UnconfirmedSends />
                </div>
              </div>
            )}

            {/* The paint stays 16px above the area's bottom (D52 §3); its 44px
                box reaches 6px past it on every side. */}
            {showScrollButton && (
              <DiscButton
                name="Scroll to latest"
                icon="latest"
                anchor="center"
                onClick={scrollToBottom}
                style={{ position: "absolute", bottom: 10, left: "50%", transform: "translateX(-50%)" }}
              />
            )}
          </div>

          <HandoffSheet />
          <ChatComposerRow wide={wide} onOpenTracker={openTracker} />
          <Composer send={send} handle={composerRef} />
        </div>
      </div>
    </div>
  );
}

/**
 * D52 R1: the latest turn of a tracked session that no replay links to the
 * host's turn, so the seen observer can never prove it was seen. The row at
 * the end of the transcript offers `Mark as seen`, which clears the tracker
 * as the reader's acknowledgement, stored as such and never as proof.
 */
function MarkAsSeen({ onMark }: { onMark: () => void }) {
  return (
    <div className="flex justify-center py-3" data-mark-seen="">
      <Button label="Mark as seen" icon="resolved" tone="ghost" size="sm" block={false} onClick={onMark} />
    </div>
  );
}

/**
 * The Working group's polite live region (D52 §3): once, when a tracker
 * changes to `needs you`, `failed` or `done` (`Tax folder cleanup needs
 * you.`). Which changes count is the tracker client's announcer
 * (`lib/tracker-announcer.ts`); this draws the words, with the label read
 * from the session list. Mounted with Chat at every width, apart from the
 * follow-ups' own region, so the two never interrupt each other.
 *
 * Each announcement is its own node, added after the last, so a burst of
 * frames that changes two trackers says both; a region whose one text was
 * replaced would say only the last. An announcement made before this
 * mounted is not spoken again.
 */
function TrackerAnnouncer() {
  const root = useBrainUiRoot();
  const announcements = useRootStore("trackers", (s) => s.announcements);
  const sessions = useRootStore("sessions", (s) => s.sessions);
  const buffers = useRootStore("chat", (s) => s.buffers);
  // The words are fixed when the announcement is made: a label that arrives
  // later must not change the region's text, which would speak it again.
  // Each root counts its own, so a replacement root starts over.
  const seen = useRef<{ root: typeof root; after: number; spoken: Map<number, string> } | null>(null);
  if (seen.current?.root !== root) seen.current = { root, after: announcements.at(-1)?.seq ?? 0, spoken: new Map() };
  const { after, spoken: words } = seen.current;
  const fresh = announcements.filter((a) => a.seq > after);
  for (const a of fresh) {
    if (!words.has(a.seq)) {
      words.set(a.seq, announcementText(a, trackerLabel(a.sessionId, sessions.find((x) => x.id === a.sessionId), { buffers })));
    }
  }
  for (const seq of words.keys()) if (!fresh.some((a) => a.seq === seq)) words.delete(seq);
  return (
    <div className="sr-only" aria-live="polite" aria-relevant="additions" data-working-live="">
      {fresh.map((a) => <span key={a.seq}>{words.get(a.seq)}</span>)}
    </div>
  );
}
