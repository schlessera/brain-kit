import { Button, Callout, Label, ListRow, Placeholder } from "@schlessera/brain-ui-kit";
import type { Tone } from "@schlessera/brain-ui-kit";

/**
 * The session drawer's body, rendered from props (S7, the `chat` directory).
 * `SessionDrawer` is the container: it owns the sessions request, the retry
 * counter, the chat-store reads (which session is in view, which are
 * running or queued) and the drawer chrome; this owns the rows.
 *
 * A session is the kit's card `ListRow`: title, when it was last active and
 * what it cost as the subtitle, the live run state as the trailing value
 * (amber "running", amber "queued", red once the host's queue note says the
 * queue is heavy), and `selected` for the one in view — teal, "the choice
 * belongs to the user". A background session still running is the first
 * row, breathing, and taps to reattach.
 */
export interface SessionRowData {
  id: string;
  title: string | null;
  /** Already formatted: "2h ago". */
  when: string;
  /** Already formatted: "$0.12", or null when nothing to say. */
  cost: string | null;
  run: "streaming" | "queued" | null;
  /** The host's queue-pressure note; present only once the queue is heavy. */
  note?: string;
}

export interface SessionGroupData {
  label: string;
  sessions: SessionRowData[];
}

export interface SessionListProps {
  groups: SessionGroupData[];
  loading: boolean;
  warning: string | null;
  currentSessionId: string | null;
  /** A running session other than the one in view, reattachable. */
  backgroundSessionId: string | null;
  onNew: () => void;
  onResume: (sessionId: string) => void;
  onRetry: () => void;
}

export function SessionList(p: SessionListProps) {
  const empty = p.groups.length === 0 && !p.backgroundSessionId;
  return (
    <div className="flex h-full flex-col">
      <div className="p-4">
        <Button label="New conversation" icon="compose" tone="suggest" size="md" center onClick={p.onNew} />
      </div>

      <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-3 pb-4">
        {p.backgroundSessionId && (
          <ListRow
            variant="card"
            icon="run"
            iconTone="amber"
            title="Session running…"
            subtitle="Tap to reattach"
            value="live"
            valueTone="amber"
            selected
            onClick={() => p.onResume(p.backgroundSessionId!)}
          />
        )}

        {p.warning && (
          <div role="status" className="flex flex-col gap-2">
            <Callout tone="gold" variant="boxed" icon="unverified" text={p.warning} />
            <div className="flex justify-end">
              <Button label="Retry" icon="retry" tone="ghost" size="sm" block={false} onClick={p.onRetry} />
            </div>
          </div>
        )}

        {p.loading ? (
          <Placeholder variant="loading" lines={3} bordered={false} pad={4} />
        ) : empty ? (
          <Placeholder variant="empty" message={p.warning ? "No sessions available" : "No sessions yet"} icon="chat" />
        ) : (
          p.groups.map((group) => (
            <section key={group.label} className="flex flex-col gap-1.5">
              <div className="px-1 pt-2">
                <Label text={group.label} />
              </div>
              {group.sessions.map((session) => {
                const tone: Tone | undefined =
                  session.run === "streaming" ? "amber" : session.run === "queued" ? (session.note ? "red" : "amber") : undefined;
                return (
                  <span key={session.id} title={session.note} className="flex">
                    <ListRow
                      variant="card"
                      icon="chat"
                      iconTone={session.id === p.currentSessionId ? "teal" : "neutral"}
                      title={session.title || "Untitled"}
                      subtitle={session.cost ? `${session.when} · ${session.cost}` : session.when}
                      value={session.run === "streaming" ? "running" : session.run === "queued" ? "queued" : undefined}
                      valueTone={tone}
                      selected={session.id === p.currentSessionId}
                      onClick={() => p.onResume(session.id)}
                    />
                  </span>
                );
              })}
            </section>
          ))
        )}
      </div>
    </div>
  );
}
