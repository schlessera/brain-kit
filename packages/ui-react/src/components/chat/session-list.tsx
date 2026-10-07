import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button, Callout, Icon, Label, ListRow, Placeholder } from "@schlessera/brain-ui-kit";
import type { IconName, Tone } from "@schlessera/brain-ui-kit";
import { useMediaQuery } from "../../hooks/use-media-query.js";

/**
 * The Sessions list, rendered from props (S7, the `chat` directory). It is
 * the body of the drawer below 1280 and of the Sessions pane at ≥1280
 * (D52 §8); `SessionDrawer` and `SessionsPane` are the containers that read
 * the stores.
 *
 * **Working** comes first: every tracked session (D52 §4), in the trackers'
 * order, each a two-line card row with its label and then its state word, in
 * the words the pills print. It replaces the old single `Session running…`
 * row. A tracked session is not listed again in its date group. A done or
 * cancelled one past the pill cap is not in Working but keeps an `unseen`
 * word on its date row, so nothing disappears silently.
 *
 * **Drafts** follow (D52 §5, #951): every nonempty draft that has no host
 * session yet, newest change first, each its own client identity. A row's
 * title is the text's first line (`Draft with 2 images` without text), its
 * trailing value `draft`, its subtitle the save state, never `saved` before
 * the host acknowledged it. Opening one opens an empty Chat with that draft
 * restored; nothing is sent and no session is created. An empty new chat
 * is never listed.
 *
 * The date groups follow, unchanged: a session is the kit's card `ListRow`
 * with its title, when it was last active and what it cost, the live run
 * state as the trailing value (amber "running", amber "queued", red once the
 * host's queue note says the queue is heavy), and `selected` for the one in
 * view: teal, "the choice belongs to the user".
 *
 * **Keyboard.** Two tab stops: `New conversation`, then one roving list
 * across Working and the date groups (↑↓ / Home / End). A row's overflow
 * (Continue on another backend) is a stop only beside the row that holds the
 * list's stop, so Tab leaves the list in one or two steps however long it is.
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
  /** A tracked session past the pill cap, not yet seen (D52 §4). */
  unseen?: boolean;
  /** The session keeps an unsent draft, this old: `now`, `2h` (D52 §5). */
  draft?: string;
}

/** One Drafts row: an unbound draft, already in words (D52 §5). */
export interface DraftRowData {
  id: string;
  title: string;
  /** The save state under the title: `draft · saved`, `draft · not saved yet`. */
  state: string;
  /** `Draft: {title}, {state}. Open draft.` */
  name: string;
  /** The draft the new-chat view shows now. */
  current: boolean;
}

export interface SessionGroupData {
  label: string;
  sessions: SessionRowData[];
}

/** One Working row: a tracker, already in the kit's words (`describeWorkingSession`). */
export interface WorkingRowData {
  id: string;
  label: string;
  /** The state word: `running · 2m`, `needs you`. */
  word: string;
  tone: Tone;
  icon: IconName;
  /** `{label}, {state}{, second line}. Open session.` */
  name: string;
}

export interface SessionListProps {
  /** Tracked sessions, in display order. */
  working?: WorkingRowData[];
  /** Unbound drafts, newest change first. */
  drafts?: DraftRowData[];
  /** Open an unbound draft in an empty Chat. */
  onOpenDraft?: (draftId: string) => void;
  groups: SessionGroupData[];
  loading: boolean;
  warning: string | null;
  currentSessionId: string | null;
  onNew: () => void;
  /**
   * Why New conversation cannot start one now, printed under it at rest; the
   * button is then `aria-disabled` (D52 §2: `already a new chat`).
   */
  newWhy?: string;
  onResume: (sessionId: string) => void;
  /** Open a tracked session from its Working row (D52 §4). */
  onOpenTracker?: (sessionId: string) => void;
  onRetry: () => void;
  onHandoff?: (sessionId: string) => void;
}

const ITEM = '[data-session-item] > [role="button"], [data-session-item] [data-session-main] > [role="button"]';

export function SessionList(p: SessionListProps) {
  // New conversation is New chat at ≥1280: a 44px reach under a coarse pointer (#951).
  const coarse = useMediaQuery("(any-pointer: coarse)", false);
  const working = p.working ?? [];
  const tracked = new Set(working.map((w) => w.id));
  const groups = p.groups
    .map((g) => ({ ...g, sessions: g.sessions.filter((s) => !tracked.has(s.id)) }))
    .filter((g) => g.sessions.length > 0);
  const drafts = p.drafts ?? [];
  const empty = groups.length === 0 && working.length === 0 && drafts.length === 0;
  const ids = [...working.map((w) => w.id), ...drafts.map((d) => d.id), ...groups.flatMap((g) => g.sessions.map((s) => s.id))];
  const [stop, setStop] = useState<string | null>(null);
  const tabStop = stop && ids.includes(stop) ? stop
    : p.currentSessionId && ids.includes(p.currentSessionId) ? p.currentSessionId
    : ids[0] ?? null;

  // A focused row can be replaced as it moves: a tracker that clears leaves
  // Working for its date group, and a new one leaves its date group. While
  // focus was in the list, the same session's new row takes it back, so
  // the arrows and Tab go on from where the reader was.
  const listRef = useRef<HTMLDivElement>(null);
  const inList = useRef(false);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!inList.current || !list || document.activeElement !== document.body) return;
    const id = typeof CSS !== "undefined" && tabStop ? CSS.escape(tabStop) : null;
    const target = (id ? list.querySelector<HTMLElement>(`[data-session="${id}"] [role="button"]`) : null) ?? list.querySelector<HTMLElement>(ITEM);
    target?.focus({ preventScroll: true });
  });

  function rove(e: KeyboardEvent<HTMLDivElement>) {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const from = e.target as HTMLElement;
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>(ITEM)];
    const here = items.indexOf(from);
    if (here === -1) return;
    e.preventDefault();
    const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1
      : Math.min(items.length - 1, Math.max(0, here + (e.key === "ArrowDown" ? 1 : -1)));
    items[next]?.focus();
  }

  return (
    <div className="flex h-full flex-col">
      <div className="p-4" data-new-conversation="">
        <Button
          label="New conversation"
          icon="compose"
          tone="suggest"
          size="md"
          center
          ariaDisabled={p.newWhy !== undefined}
          // 44px under a coarse pointer, taken from the row's own padding, so
          // the list below keeps its height.
          {...(coarse ? { style: { minHeight: 44, marginBlock: -4 } } : {})}
          subtitle={p.newWhy}
          onClick={() => { if (p.newWhy === undefined) p.onNew(); }}
        />
      </div>

      <div
        ref={listRef}
        className="flex flex-1 flex-col gap-2 overflow-y-auto px-3 pb-4"
        data-session-scroll=""
        onKeyDown={rove}
        onFocus={() => { inList.current = true; }}
        onBlur={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          // A row removed while focused blurs on its way out: that is the
          // case the effect above repairs, so it does not count as leaving.
          const from = e.target;
          queueMicrotask(() => { if (from.isConnected) inList.current = false; });
        }}
      >
        {p.warning && (
          <div role="status" className="flex flex-col gap-2">
            <Callout tone="gold" variant="boxed" icon="unverified" text={p.warning} />
            <div className="flex justify-end">
              <Button label="Retry" icon="retry" tone="ghost" size="sm" block={false} onClick={p.onRetry} />
            </div>
          </div>
        )}

        {working.length > 0 && (
          // The group a press of Sessions focuses first (D52 N3).
          <section aria-label="Working" className="flex flex-col gap-1.5" data-working-group="">
            <div className="px-1 pt-2">
              <Label text="Working" />
            </div>
            {working.map((w) => (
              <div key={w.id} data-session-item="" data-working-row="" data-session={w.id}>
                <ListRow
                  variant="card"
                  icon={w.icon}
                  iconTone={w.tone}
                  title={w.label}
                  subtitle={w.word}
                  subMono
                  name={w.name}
                  selected={w.id === p.currentSessionId}
                  tabStop={w.id === tabStop}
                  onFocus={() => setStop(w.id)}
                  onClick={() => (p.onOpenTracker ?? p.onResume)(w.id)}
                />
              </div>
            ))}
          </section>
        )}

        {drafts.length > 0 && (
          <section aria-label="Drafts" className="flex flex-col gap-1.5" data-drafts-group="">
            <div className="px-1 pt-2">
              <Label text="Drafts" />
            </div>
            {drafts.map((d) => (
              <div key={d.id} data-session-item="" data-draft-row="" data-session={d.id}>
                <ListRow
                  variant="card"
                  icon="compose"
                  iconTone="neutral"
                  title={d.title}
                  subtitle={d.state}
                  subMono
                  value="draft"
                  name={d.name}
                  selected={d.current}
                  tabStop={d.id === tabStop}
                  onFocus={() => setStop(d.id)}
                  onClick={() => p.onOpenDraft?.(d.id)}
                />
              </div>
            ))}
          </section>
        )}

        {p.loading && empty ? (
          <Placeholder variant="loading" lines={3} bordered={false} pad={4} />
        ) : empty ? (
          <Placeholder variant="empty" message={p.warning ? "No sessions available" : "No sessions yet"} icon="chat" />
        ) : (
          groups.map((group) => (
            <section key={group.label} className="flex flex-col gap-1.5">
              <div className="px-1 pt-2">
                <Label text={group.label} />
              </div>
              {group.sessions.map((session) => {
                const tone: Tone | undefined =
                  session.run === "streaming" ? "amber" : session.run === "queued" ? (session.note ? "red" : "amber") : undefined;
                const subtitle = [session.from ? `from: ${session.from}` : null, session.when, session.cost].filter(Boolean).join(" · ");
                const value = session.run === "streaming" ? "running" : session.run === "queued" ? "queued" : session.unseen ? "unseen"
                  : session.draft !== undefined ? `draft · ${session.draft}` : undefined;
                return (
                  <span key={session.id} title={session.note} className="flex items-stretch gap-1" data-session-row="" data-session-item="" data-session={session.id}>
                    <span className="flex min-w-0 flex-1" data-session-main="">
                      <ListRow
                        variant="card"
                        icon="chat"
                        iconTone={session.id === p.currentSessionId ? "teal" : "neutral"}
                        title={session.title || "Untitled"}
                        subtitle={subtitle}
                        {...(session.draft !== undefined ? { name: `${session.title || "Untitled"}, has a draft. Open session.` } : {})}
                        value={value}
                        valueTone={tone ?? (session.unseen ? "teal" : undefined)}
                        selected={session.id === p.currentSessionId}
                        tabStop={session.id === tabStop}
                        onFocus={() => setStop(session.id)}
                        onClick={() => p.onResume(session.id)}
                      />
                    </span>
                    {session.handoff && p.onHandoff ? (
                      <SessionOverflow
                        title={session.title || "Untitled"}
                        why={session.handoff.why}
                        tabStop={session.id === tabStop}
                        onHandoff={() => p.onHandoff!(session.id)}
                      />
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
function SessionOverflow({ title, why, tabStop, onHandoff }: { title: string; why?: string; tabStop: boolean; onHandoff: () => void }) {
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
        tabIndex={tabStop || open ? 0 : -1}
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
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); close(); } }}
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
