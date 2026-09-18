import { useState, useEffect } from "react";
import { useBrainUiRoot } from "../../root-context.js";
import { useChatStore } from "../../stores/chat-store.js";
import { SlidePanel } from "../layout/slide-panel.js";
import { SessionList } from "./session-list.js";
import { formatRelativeTime } from "./tool-views.js";

interface SessionInfo {
  id: string;
  title: string | null;
  createdAt: number;
  lastActiveAt: number;
  totalCostUsd?: number;
}

interface GroupedSessions {
  label: string;
  sessions: SessionInfo[];
}

/**
 * The container (S7): the sessions request, the retry counter and the
 * chat-store reads live here; `SessionList` draws the rows.
 */
export function SessionDrawer({
  open,
  onClose,
  onResume,
}: {
  open: boolean;
  onClose: () => void;
  onResume: (sessionId: string) => void;
}) {
  const root = useBrainUiRoot();
  const api = root.api;
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const clearMessages = useChatStore((s) => s.clearMessages);
  const currentSessionId = useChatStore((s) => s.activeSessionId);
  const runStates = useChatStore((s) => s.runStates);
  const queueNotes = useChatStore((s) => s.queueNotes);
  // A running/queued session other than the one in view is reattachable. Derive
  // it from the live per-session run-state (kept current by the frame demux)
  // rather than the deprecated status.activeSessionId, which multi-session
  // servers no longer send.
  const backgroundSessionId =
    Object.keys(runStates).find((id) => id !== currentSessionId) ?? null;

  useEffect(() => { setSessions([]); setWarning(null); }, [root]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setWarning(null);
    api.sessions()
      .then((data) => {
        if (!active) return;
        setSessions(data.sessions);
        setWarning(data.unavailableBackends?.length
          ? "Some session histories are unavailable. Showing available sessions."
          : null);
      })
      .catch(() => {
        if (active) setWarning("Could not refresh sessions. Please retry.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, retry, root, api]);

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
      };
    }),
  }));

  return (
    <SlidePanel open={open} onClose={onClose} title="Sessions" wide>
      <SessionList
        groups={groups}
        loading={loading}
        warning={warning}
        currentSessionId={currentSessionId}
        backgroundSessionId={backgroundSessionId}
        onNew={() => {
          clearMessages();
          onClose();
        }}
        onResume={(id) => {
          onResume(id);
          onClose();
        }}
        onRetry={() => setRetry((value) => value + 1)}
      />
    </SlidePanel>
  );
}

function groupSessionsByDate(sessions: SessionInfo[]): GroupedSessions[] {
  const dayMs = 86400000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const yesterdayMs = todayMs - dayMs;
  const weekAgoMs = todayMs - 7 * dayMs;

  const groups: Record<string, SessionInfo[]> = {
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
