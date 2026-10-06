import { useEffect, useId, useRef, useState } from "react";
import { Button, Callout, Icon, Label, ListRow, Placeholder } from "@schlessera/brain-ui-kit";
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
  /** A handoff destination's source title (#61): `from: Ithaca return`. */
  from?: string;
  /**
   * Present when the row's overflow offers Continue on another backend
   * (#61); `why` is why it cannot run now, printed rather than hidden.
   */
  handoff?: { why?: string };
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
  onHandoff?: (sessionId: string) => void;
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
          // Marked as the Working row a press of Sessions focuses until
          // #950's Working group exists (D52 N3 addendum).
          <div data-session-running="">
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
          </div>
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
                const subtitle = [session.from ? `from: ${session.from}` : null, session.when, session.cost].filter(Boolean).join(" · ");
                return (
                  <span key={session.id} title={session.note} className="flex items-stretch gap-1" data-session-row="">
                    <span className="flex min-w-0 flex-1">
                      <ListRow
                        variant="card"
                        icon="chat"
                        iconTone={session.id === p.currentSessionId ? "teal" : "neutral"}
                        title={session.title || "Untitled"}
                        subtitle={subtitle}
                        value={session.run === "streaming" ? "running" : session.run === "queued" ? "queued" : undefined}
                        valueTone={tone}
                        selected={session.id === p.currentSessionId}
                        onClick={() => p.onResume(session.id)}
                      />
                    </span>
                    {session.handoff && p.onHandoff ? (
                      <SessionOverflow title={session.title || "Untitled"} why={session.handoff.why} onHandoff={() => p.onHandoff!(session.id)} />
                    ) : null}
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

/**
 * A session row's overflow (#61 §1): its one action is Continue on another
 * backend. Without another backend the item stays, announced as dimmed,
 * with its reason printed.
 */
function SessionOverflow({ title, why, onHandoff }: { title: string; why?: string; onHandoff: () => void }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const item = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open) item.current?.focus(); }, [open]);
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  return (
    <span className="relative flex">
      <button
        ref={trigger}
        type="button"
        aria-label={`More for ${title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        className="flex w-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        <Icon icon="more" size={18} />
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={`Actions for ${title}`}
          onKeyDown={(e) => { if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); e.stopPropagation(); close(); } }}
          onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null) && e.relatedTarget !== trigger.current) setOpen(false); }}
          className="absolute right-0 top-full z-50 mt-1 w-64 overflow-hidden rounded-xl border border-border bg-surface-raised shadow-2xl"
        >
          <button
            ref={item}
            type="button"
            role="menuitem"
            aria-disabled={why ? true : undefined}
            onClick={() => { if (why) return; setOpen(false); onHandoff(); }}
            className="flex min-h-11 w-full flex-col items-start justify-center px-3 py-2 text-left text-sm text-foreground hover:bg-surface aria-disabled:text-muted-foreground aria-disabled:hover:bg-transparent focus-visible:outline-none focus-visible:bg-surface"
          >
            <span>Continue on another backend…</span>
            {why ? <span className="font-mono text-[11px] text-muted-foreground">{why}</span> : null}
          </button>
        </div>
      ) : null}
    </span>
  );
}
