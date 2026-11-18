import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Icon, type IconName } from "../primitives/Icon.js";
import { Overlay } from "./Overlay.js";

/**
 * Compact operation status (#3281). Presentational only: the consumer owns
 * every state, fact, action and its authority. Nothing here infers success
 * from time, animation or response order, and opening details has no effect.
 */
export type StatusIndicatorState = "active" | "queued" | "success" | "attention" | "unknown" | "failed" | "refused" | "idle";

export interface StatusIndicatorFact {
  key: string;
  value: string;
}

export interface StatusIndicatorOperation {
  /** The consumer's stable operation identity; React keys and actions follow it, never the array index. */
  id: string;
  /** Must come from authoritative consumer evidence. `unknown` is never success. */
  state: StatusIndicatorState;
  /** The state in the consumer's words, e.g. "Couldn't confirm the draft was saved". */
  stateLabel: string;
  explanation?: string;
  facts?: StatusIndicatorFact[];
  /** Consumer buttons, rendered in details only. Opening details never triggers them. */
  actions?: ReactNode;
}

export interface StatusIndicatorProps {
  /** What the status is about: "Draft", "Chat deletions". */
  label: string;
  /** One sentence for the tooltip and the top of details; it must not hide mixed outcomes. */
  summary: string;
  /** Details heading. */
  title: string;
  /** Zero or more operations. Empty renders a reserved, control-free slot: idle, never success. */
  operations: StatusIndicatorOperation[];
  /** Focus target when details close after the trigger has gone. */
  returnFocus?: () => HTMLElement | null;
  /**
   * False when the consumer announces this status itself (additive): the
   * indicator then renders no live region, so one change is never spoken
   * twice. Defaults to true.
   */
  announce?: boolean;
}

/** The approved matrix: one distinct existing glyph per state, existing semantic tones. */
const STATES = {
  refused: { icon: "unreachable", tone: "red", word: "Refused" },
  failed: { icon: "stopped", tone: "red", word: "Failed" },
  unknown: { icon: "unproven", tone: "gold", word: "Unknown" },
  attention: { icon: "attention", tone: "gold", word: "Needs attention" },
  active: { icon: "loading", tone: "amber", word: "Working" },
  queued: { icon: "later", tone: "neutral", word: "Queued" },
  success: { icon: "finished", tone: "teal", word: "Confirmed" },
  idle: { icon: "withdrawn", tone: "neutral", word: "Idle" },
} as const satisfies Record<StatusIndicatorState, { icon: IconName; tone: string; word: string }>;

/** Display priority, worst first. Derived for the glyph and count only. */
const PRIORITY = Object.keys(STATES) as StatusIndicatorState[];
/** States whose entry is always announced, even inside a coalescing window. */
const ALERTS = new Set<StatusIndicatorState>(["attention", "unknown", "failed", "refused"]);

/** The operation whose state the compact glyph shows; undefined for an empty list. */
export function statusIndicatorLead(operations: readonly StatusIndicatorOperation[]): StatusIndicatorOperation | undefined {
  let lead: StatusIndicatorOperation | undefined;
  for (const operation of operations) {
    if (!lead || PRIORITY.indexOf(operation.state) < PRIORITY.indexOf(lead.state)) lead = operation;
  }
  return lead;
}

function StateLine({ state, label }: { state: StatusIndicatorState; label: string }) {
  const s = STATES[state];
  return <p className="bk-status-state" data-tone={s.tone}>
    <span className="bk-status-state-glyph" aria-hidden="true"><Icon icon={s.icon} size={16} /></span>
    <span className="bk-status-state-word">{s.word}</span>
    <span className="bk-status-state-label">{label}</span>
  </p>;
}

/** One coalesced polite path: state changes only, alerts never swallowed, progress text silent. */
function useAnnouncement(label: string, operations: readonly StatusIndicatorOperation[]) {
  const [message, setMessage] = useState("");
  const lead = statusIndicatorLead(operations);
  const display = lead?.state ?? "idle";
  const alerts = operations.filter(o => ALERTS.has(o.state)).map(o => `${o.id}\u0000${o.state}`);
  const announced = useRef({ display, alerts: new Set(alerts) });
  const pendingAlert = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef({ label, operations });
  latest.current = { label, operations };
  const alertKey = alerts.join("\u0001");
  useEffect(() => {
    const previous = announced.current;
    const entered = alerts.some(key => !previous.alerts.has(key));
    if (entered) pendingAlert.current = true;
    if (display === previous.display && !pendingAlert.current) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const { label: name, operations: now } = latest.current;
      const current = statusIndicatorLead(now);
      const state = current?.state ?? "idle";
      const nowAlerts = now.filter(o => ALERTS.has(o.state));
      const fresh = nowAlerts.filter(o => !announced.current.alerts.has(`${o.id}\u0000${o.state}`));
      const alerted = pendingAlert.current && fresh.length > 0;
      pendingAlert.current = false;
      if (state === announced.current.display && !alerted) return;
      announced.current = { display: state, alerts: new Set(nowAlerts.map(o => `${o.id}\u0000${o.state}`)) };
      const spoken = alerted ? fresh.map(o => o.stateLabel) : [current?.stateLabel ?? STATES.idle.word];
      const count = now.length > 1 ? `; ${now.length} operations` : "";
      // Clear first so identical consecutive text is still spoken.
      setMessage("");
      queueMicrotask(() => setMessage(`${name}: ${spoken.join("; ")}${count}.`));
    }, 1000);
    // Keyed on the derived state and alert identities only: progress text is silent.
  }, [display, alertKey]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return message;
}

/** A 20px state glyph in a native 44px button, with equivalent hover, focus and tap details. */
export function StatusIndicator(p: StatusIndicatorProps) {
  const id = useId();
  const headingId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 16, top: 16 });
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const suppressed = useRef(false);
  const skipFocus = useRef(false);
  const hovered = useRef(false);
  // After details close under a resting pointer, hover rearms only once it leaves.
  const rearm = useRef(false);
  const announcement = useAnnouncement(p.label, p.operations);
  const lead = statusIndicatorLead(p.operations);
  const empty = lead === undefined;
  const state = lead?.state ?? "idle";
  const s = STATES[state];
  const count = p.operations.length;
  const name = `${p.label}: ${lead?.stateLabel ?? s.word}${count > 1 ? `; ${count} operations` : ""}. Details.`;

  const clear = () => { clearTimeout(pending.current); };
  const hide = () => { clear(); setShown(false); };
  const enter = () => { clear(); suppressed.current = false; pending.current = setTimeout(() => { if (!suppressed.current && !open) setShown(true); }, 300); };
  const leave = () => { clear(); pending.current = setTimeout(() => { if (!hovered.current && trigger.current?.ownerDocument.activeElement !== trigger.current) setShown(false); }, 150); };
  useEffect(() => () => clearTimeout(pending.current), []);
  // An emptied list removes the control; its details have nothing left to show.
  useEffect(() => { if (empty) { setOpen(false); setShown(false); } }, [empty]);

  useLayoutEffect(() => {
    if (!shown) return;
    const node = trigger.current;
    if (!node) return;
    const doc = node.ownerDocument;
    const win = doc.defaultView!;
    const place = () => {
      const box = node.getBoundingClientRect();
      const hint = tooltip.current!.getBoundingClientRect();
      const left = Math.max(16, Math.min(box.left, win.innerWidth - hint.width - 16));
      const above = box.top - hint.height - 8;
      const top = Math.max(8, Math.min(above >= 8 ? above : box.bottom + 8, win.innerHeight - hint.height - 8));
      setPosition({ left, top });
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      suppressed.current = true; clearTimeout(pending.current); setShown(false);
      event.preventDefault(); event.stopPropagation();
    };
    place();
    win.addEventListener("resize", place);
    doc.addEventListener("scroll", place, true);
    doc.addEventListener("keydown", escape, true);
    return () => { win.removeEventListener("resize", place); doc.removeEventListener("scroll", place, true); doc.removeEventListener("keydown", escape, true); };
  }, [shown]);

  const returnFocus = () => trigger.current?.isConnected ? trigger.current : p.returnFocus?.() ?? null;
  const portal = trigger.current?.ownerDocument.body;
  const scheme = () => trigger.current ? getComputedStyle(trigger.current).colorScheme : undefined;
  // Exactly one live region exists: inside the modal while it is open (the
  // rest of the page is inert then), beside the trigger otherwise.
  const live = p.announce === false ? null : <span className="bk-sr-only" aria-live="polite" data-status-live="">{announcement}</span>;

  return <span className="bk-status-indicator" data-status-indicator={empty ? "empty" : state} data-tone={s.tone} data-count={count > 1 ? count : undefined}>
    {empty ? <span className="bk-status-indicator-slot" aria-hidden="true" /> : <button
      // raw-button: kit — A status control needs focus/hover descriptions without IconButton's native title tooltip.
      type="button" ref={trigger} className="bk-control bk-status-indicator-btn"
      aria-label={name} aria-haspopup="dialog" aria-expanded={open} aria-controls={`${id}-details`} aria-describedby={shown ? `${id}-tooltip` : undefined}
      onPointerEnter={event => { if (event.pointerType !== "touch") { hovered.current = true; if (!rearm.current) enter(); } }}
      onPointerLeave={() => { hovered.current = false; rearm.current = false; leave(); }}
      onFocus={() => { if (skipFocus.current) { skipFocus.current = false; return; } enter(); }} onBlur={leave}
      onClick={() => { hide(); suppressed.current = true; setOpen(true); }}>
      <span className="bk-status-glyph" aria-hidden="true"><Icon icon={s.icon} size={20} /></span>
      {count > 1 && <span className="bk-status-count" aria-hidden="true">{count}</span>}
    </button>}
    {!open && live}
    {portal && shown && !empty && createPortal(<div id={`${id}-tooltip`} ref={tooltip} role="tooltip" className="bk-status-tooltip" style={{ ...position, colorScheme: scheme() }}
      onPointerEnter={() => { hovered.current = true; clear(); }} onPointerLeave={() => { hovered.current = false; leave(); }}>
      {p.summary}
    </div>, portal)}
    {portal && open && createPortal(<div style={{ colorScheme: scheme() }}>
      <Overlay data-status-details="" id={`${id}-details`} open={open} variant="dialog" labelledBy={headingId} initialFocus={heading} returnFocus={returnFocus} closeLabel={`Close ${p.title.toLowerCase()}`}
        onClose={() => { suppressed.current = true; skipFocus.current = true; rearm.current = true; setOpen(false); }}>
        <div className="bk-status-details">
          <h2 id={headingId} ref={heading} tabIndex={-1}>{p.title}</h2>
          <p>{p.summary}</p>
          <ul className="bk-status-operations">
            {p.operations.map(operation => <li key={operation.id} data-status-operation={operation.id} data-state={operation.state}>
              <StateLine state={operation.state} label={operation.stateLabel} />
              {operation.explanation && <p>{operation.explanation}</p>}
              {operation.facts && operation.facts.length > 0 && <dl className="bk-status-facts">
                {operation.facts.map(fact => <div key={fact.key}><dt>{fact.key}</dt><dd>{fact.value}</dd></div>)}
              </dl>}
              {operation.actions && <div className="bk-status-actions">{operation.actions}</div>}
            </li>)}
          </ul>
          {live}
        </div>
      </Overlay>
    </div>, portal)}
  </span>;
}
