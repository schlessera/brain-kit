import { useEffect, useMemo, useRef } from "react";
import { describeWorkingSession } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot, useRootStore } from "../../root-context.js";
import { useChatStore } from "../../stores/chat-store.js";
import { SlidePanel } from "../layout/slide-panel.js";
import { SessionList, type SessionListProps, type WorkingRowData } from "./session-list.js";
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
        ...(session.handoffFrom ? { from: session.handoffFrom.title || "an earlier chat" } : {}),
        // A stored session with a settled turn can continue elsewhere.
        ...((session.numTurns ?? 0) > 0 ? { handoff: { why: handoffWhy(providers, session.backendId, connected, unavailable, backendName) } } : {}),
      };
    }),
  }));

  return {
    working,
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
