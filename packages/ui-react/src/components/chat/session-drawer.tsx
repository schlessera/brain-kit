import { useState, useEffect } from "react";
import { Plus, Loader2 } from "lucide-react";
import { api } from "../../lib/api-client.js";
import { useChatStore } from "../../stores/chat-store.js";
import { SlidePanel } from "../layout/slide-panel.js";
import { cn } from "../../lib/utils.js";
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

export function SessionDrawer({
  open,
  onClose,
  onResume,
}: {
  open: boolean;
  onClose: () => void;
  onResume: (sessionId: string) => void;
}) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
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

  useEffect(() => {
    if (open) {
      setLoading(true);
      api
        .sessions()
        .then((data) => setSessions(data.sessions))
        .catch(() => setSessions([]))
        .finally(() => setLoading(false));
    }
  }, [open]);

  const groups = groupSessionsByDate(sessions);

  return (
    <SlidePanel open={open} onClose={onClose} title="Sessions" wide>
      <div className="flex h-full flex-col">
        {/* New chat button */}
        <div className="p-4">
          <button
            onClick={() => {
              clearMessages();
              onClose();
            }}
            className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary/30 py-3 text-[13px] font-medium text-primary transition-all hover:border-primary/50 hover:bg-primary/5"
          >
            <Plus className="h-4 w-4" />
            New conversation
          </button>
        </div>

        {/* Session list */}
        <div className="flex-1 overflow-y-auto px-2 pb-4">
          {/* Active session banner */}
          {backgroundSessionId && (
            <div className="px-2 pb-2">
              <button
                onClick={() => {
                  onResume(backgroundSessionId);
                  onClose();
                }}
                className="flex w-full items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5 text-left transition-colors hover:bg-primary/10"
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full bg-primary"
                  style={{ animation: "breathe 2s ease-in-out infinite" }}
                />
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-foreground">
                    Session running...
                  </div>
                  <div className="text-[11px] text-primary">
                    Tap to reattach
                  </div>
                </div>
              </button>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : sessions.length === 0 && !backgroundSessionId ? (
            <p className="py-12 text-center text-xs text-muted-foreground">
              No sessions yet
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.label}>
                <div className="px-3 py-2 font-[family-name:var(--font-mono)] text-[10px] font-medium uppercase tracking-widest text-muted-foreground/40">
                  {group.label}
                </div>
                {group.sessions.map((session) => (
                  <button
                    key={session.id}
                    onClick={() => {
                      onResume(session.id);
                      onClose();
                    }}
                    className={cn(
                      "w-full rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-surface-raised",
                      session.id === currentSessionId &&
                        "border-l-2 border-primary bg-primary/5"
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                        {session.title || "Untitled"}
                      </div>
                      <RunBadge state={runStates[session.id]} note={queueNotes[session.id]} />
                    </div>
                    <div className="mt-0.5 flex items-center gap-2">
                      <span className="text-[11px] text-muted-foreground">
                        {formatRelativeTime(session.lastActiveAt)}
                      </span>
                      {session.totalCostUsd != null &&
                        session.totalCostUsd > 0 && (
                          <span className="text-[11px] text-muted-foreground/40">
                            ${session.totalCostUsd.toFixed(2)}
                          </span>
                        )}
                    </div>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </SlidePanel>
  );
}

/** Live run-state pill on a session row (streaming / queued). */
function RunBadge({
  state,
  note,
}: {
  state?: "streaming" | "queued" | "idle";
  /** Host's queue-pressure note, present only once the queue is heavy. */
  note?: string;
}) {
  if (state !== "streaming" && state !== "queued") return null;
  const running = state === "streaming";
  // A note only ever accompanies a queue under pressure, so it doubles as the
  // "this is getting heavy" signal: the pill turns red and says how much.
  const heavy = !running && Boolean(note);
  return (
    <span
      title={note}
      className={cn(
        "shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide",
        running
          ? "bg-primary/15 text-primary"
          : heavy
            ? "bg-destructive/15 text-destructive"
            : "bg-amber-500/15 text-amber-500"
      )}
    >
      {running ? "Running" : "Queued"}
    </span>
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
