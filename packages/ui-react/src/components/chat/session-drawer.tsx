import { useEffect, useMemo, useRef } from "react";
import { describeWorkingSession } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot, useRootStore } from "../../root-context.js";
import { useChatStore } from "../../stores/chat-store.js";
import { SlidePanel } from "../layout/slide-panel.js";
import { SessionList, type DraftRowData, type SessionListProps, type WorkingRowData } from "./session-list.js";
import { boundDrafts, draftEntries, draftEntryWord, draftSaveView, draftTitle, trackStateWord } from "../../lib/drafts.js";
import { useStagedTracks } from "../../hooks/use-staged-tracks.js";
import { formatRelativeTime } from "./tool-views.js";
import { useProviderStore } from "../../stores/provider-store.js";
import { useConnectionStore } from "../../stores/connection-store.js";
import { handoffWhy } from "../../hooks/use-handoff-entry.js";
import { useBackendName } from "./handoff-links.js";
import { mintHandoffId } from "../../lib/handoff.js";
import { useDestinationPress } from "../../hooks/use-destination-press.js";
import { focusFirst, scrollToStart } from "../../lib/destination-start.js";
import { useNow } from "../../hooks/use-now.js";
import { useWorkingSessions } from "../../hooks/use-working-sessions.js";
import type { ListedSession } from "../../stores/session-list-state.js";
import { useLocalWorkStatus } from "../../hooks/use-local-work.js";

interface GroupedSessions {
  label: string;
  sessions: ListedSession[];
}

/** How often the Working rows' ages (`running · 2m`) are redrawn. */
const AGE_TICK_MS = 30_000;

/**
 * The props both Sessions containers hand `SessionList`: the root's session
 * list, its trackers as Working rows, and the chat-store reads (which
 * session is in view, which are running or queued). `visible` asks the host
 * for the list again each time the surface comes into view.
 */
export function useSessionListProps({ visible, onResume, onOpenTracker, onLeave }: {
  visible: boolean;
  onResume: (sessionId: string) => void;
  onOpenTracker: (sessionId: string) => void;
  /** After a row, New conversation or a handoff has acted: the drawer closes. */
  onLeave?: () => void;
}): SessionListProps {
  const root = useBrainUiRoot();
  const sessions = useRootStore("sessions", (s) => s.sessions);
  const loading = useRootStore("sessions", (s) => s.loading);
  const warning = useRootStore("sessions", (s) => s.warning);
  const clearMessages = useChatStore((s) => s.clearMessages);
  const currentSessionId = useChatStore((s) => s.activeSessionId);
  const runStates = useChatStore((s) => s.runStates);
  const queueNotes = useChatStore((s) => s.queueNotes);
  const providers = useProviderStore((s) => s.available);
  const unavailable = useProviderStore((s) => s.unavailable);
  const backendName = useBackendName();
  const connected = useConnectionStore((s) => s.wsStatus === "connected");
  const tracked = useWorkingSessions();
  const now = useNow(AGE_TICK_MS);
  const drafts = useRootStore("drafts", (s) => s.drafts);
  const fresh = useRootStore("drafts", (s) => s.fresh);
  const supported = useRootStore("drafts", (s) => s.supported);
  const limits = useRootStore("drafts", (s) => s.limits);

  const staged = useStagedTracks();
  const localFailed = useLocalWorkStatus((s) => s.failed);

  // Drafts (D52 §5): unbound ones are entries of their own; a session's own
  // marks its row. Content stays in the draft store; only words come here.
  // A new chat's staged tracks join its entry, or are one (#1112): they
  // live in this page only, so their words never say saved.
  const draftRows: DraftRowData[] = useMemo(() => draftEntries(drafts, staged, root.stores.drafts.getState().originOf).map(({ id, draft: d, tracks }) => {
    const current = currentSessionId === null && id === fresh;
    const trackWord = tracks ? trackStateWord(tracks) : null;
    if (!d) {
      const title = draftTitle({ text: "", attachments: [], tracks: tracks!.count });
      return { id, title, state: `draft · ${trackWord}`, name: `Draft: ${title}, ${trackWord}. Open draft.`, current };
    }
    const word = draftEntryWord(d, { supported, limits, localFailed }, now);
    const title = draftTitle({ ...d, tracks: tracks?.count ?? 0 });
    if (trackWord) return { id, title, state: `draft · ${word} · ${trackWord}`, name: `Draft: ${title}, ${word}, ${trackWord}. Open draft.`, current };
    const view = draftSaveView(d, { supported, limits, localFailed }, now);
    const state = view.state === "none" ? "draft · not saved yet" : view.copy;
    return { id, title, state, name: `Draft: ${title}, ${word}. Open draft.`, current };
  }), [drafts, staged, root, supported, limits, localFailed, now, currentSessionId, fresh]);
  const sessionDrafts = useMemo(() => boundDrafts(drafts), [drafts]);

  useEffect(() => {
    if (visible) void root.stores.sessions.getState().refresh();
  }, [visible, root]);

  const working: WorkingRowData[] = useMemo(() => tracked.shown.map((s) => {
    const view = describeWorkingSession({ ...s, onOpen: () => {} }, now);
    return { id: s.id, label: s.label, word: view.word, tone: view.tone, icon: view.icon, name: view.name };
  }), [tracked, now]);

  const groups = groupSessionsByDate(sessions).map((group) => ({
    label: group.label,
    sessions: group.sessions.map((session) => {
      const state = runStates[session.id];
      return {
        id: session.id,
        title: session.title,
        when: formatRelativeTime(session.lastActiveAt),
        cost: session.totalCostUsd != null && session.totalCostUsd > 0 ? `$${session.totalCostUsd.toFixed(2)}` : null,
        run: state === "streaming" || state === "queued" ? state : null,
        note: queueNotes[session.id],
        ...(tracked.overflow.has(session.id) ? { unseen: true } : {}),
        ...(sessionDrafts.has(session.id) ? { draft: draftAge(now - sessionDrafts.get(session.id)!.editedAt) } : {}),
        ...(session.handoffFrom ? { from: session.handoffFrom.title || "an earlier chat" } : {}),
        // A stored session with a settled turn can continue elsewhere.
        ...((session.numTurns ?? 0) > 0 ? { handoff: { why: handoffWhy(providers, session.backendId, connected, unavailable, backendName) } } : {}),
      };
    }),
  }));

  return {
    working,
    drafts: draftRows,
    onOpenDraft: (id) => {
      // An empty Chat with that draft restored: nothing is sent, and no
      // session is created.
      root.stores.chat.getState().clearMessages();
      root.stores.drafts.getState().openUnbound(id);
      root.stores.ui.getState().setActiveView("chat");
      onLeave?.();
    },
    groups,
    loading,
    warning,
    currentSessionId,
    onNew: () => {
      clearMessages();
      onLeave?.();
    },
    onResume: (id) => {
      onResume(id);
      onLeave?.();
    },
    onOpenTracker: (id) => {
      onLeave?.();
      onOpenTracker(id);
    },
    onRetry: () => void root.stores.sessions.getState().refresh(),
    onHandoff: (id) => {
      const backendId = sessions.find((session) => session.id === id)?.backendId;
      if (backendId) root.stores.chat.getState().setSessionBackend(id, backendId);
      onResume(id);
      onLeave?.();
      // The resume above replays fresh history; the review waits for it.
      root.stores.handoff.getState().open(id, mintHandoffId(), { awaitHistory: true });
    },
  };
}

/**
 * Sessions below 1280: the existing drawer (S7). The container reads the
 * stores through `useSessionListProps`; `SessionList` draws the rows. At
 * ≥1280 Sessions is the pane beside the transcript instead (`SessionsPane`).
 */
export function SessionDrawer({
  open,
  onClose,
  onResume,
  onOpenTracker,
}: {
  open: boolean;
  onClose: () => void;
  onResume: (sessionId: string) => void;
  /** Open a tracked session from its Working row; defaults to `onResume`. */
  onOpenTracker?: (sessionId: string) => void;
}) {
  const props = useSessionListProps({ visible: open, onResume, onOpenTracker: onOpenTracker ?? onResume, onLeave: onClose });

  // Pressing Sessions while it is open (D52 N3): the drawer body and the list
  // go to the top, and focus goes to the first Working row; then the session
  // in view, the first row, and the heading of an empty list.
  const panelRef = useRef<HTMLElement>(null);
  useDestinationPress("sessions", ({ keyboard }) => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    scrollToStart(panel);
    const row = (sel: string) => panel.querySelector<HTMLElement>(sel);
    focusFirst([
      row('[data-working-row] [role="button"]'),
      row('[data-session-row] [role="button"][aria-current="true"]'),
      row('[data-session-row] [role="button"]'),
      row("[data-destination-heading]"),
    ], keyboard);
  });

  return (
    <SlidePanel open={open} onClose={onClose} title="Sessions" wide destination panelRef={panelRef}>
      <SessionList {...props} />
    </SlidePanel>
  );
}

/** How old a session's draft is, as its row prints it: `now`, `5m`, `2h`, `3d`. */
function draftAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function groupSessionsByDate(sessions: readonly ListedSession[]): GroupedSessions[] {
  const dayMs = 86400000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const yesterdayMs = todayMs - dayMs;
  const weekAgoMs = todayMs - 7 * dayMs;

  const groups: Record<string, ListedSession[]> = {
    Today: [],
    Yesterday: [],
    "This week": [],
    Earlier: [],
  };

  for (const s of sessions) {
    if (s.lastActiveAt >= todayMs) {
      groups.Today.push(s);
    } else if (s.lastActiveAt >= yesterdayMs) {
      groups.Yesterday.push(s);
    } else if (s.lastActiveAt >= weekAgoMs) {
      groups["This week"].push(s);
    } else {
      groups.Earlier.push(s);
    }
  }

  return Object.entries(groups)
    .filter(([, sessions]) => sessions.length > 0)
    .map(([label, sessions]) => ({ label, sessions }));
}
