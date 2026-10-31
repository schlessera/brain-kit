import { createContext, useContext, useMemo, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "../primitives/Icon.js";
import { Overlay } from "../chrome/Overlay.js";
import { TextButton } from "../primitives/TextButton.js";

interface TranscriptReadingScopeProps {
  onRead: (opener: HTMLElement) => void;
  returnFocus: () => HTMLElement | null;
  children: ReactNode;
}
const ReadingOwner = createContext<Omit<TranscriptReadingScopeProps, "children"> | null>(null);

/** Concrete transcript lifetime coordination; canonical entries stay in the host timeline. */
export function TranscriptReadingScope({ onRead, returnFocus, children }: TranscriptReadingScopeProps) {
  const owner = useMemo(() => ({ onRead, returnFocus }), [onRead, returnFocus]);
  return <ReadingOwner.Provider value={owner}>{children}</ReadingOwner.Provider>;
}

/** Closed first-party display vocabulary. This is evidence, never an action or authority. */
const vocabulary = {
  recognized: { icon: "unverified", role: "Recognized speech", copy: "Recognized speech. Words may be uncertain; speaker unverified." },
  generated: { icon: "suggestion", role: "Voice reply", copy: "Generated voice reply. This is service-generated text, not a host task result." },
  "task-request": { icon: "steps", role: "Host task request", copy: "Host task request from conversation context. This is not a verified user quote." },
  "task-result": { icon: "ledger", role: "Task result", copy: "Host task result. Linked by the host request identity." },
  played: { icon: "run", copy: "Received audio chunks played locally; spoken portion unknown." },
  unknown: { icon: "unproven", copy: "Playback unknown. Generated words are not proof they were spoken." },
  "not-spoken": { icon: "unreachable", copy: "Remaining reply not spoken locally. Earlier spoken portion unknown." },
  unsaved: { icon: "unreachable", copy: "Unsaved text evidence. These words are not saved and are unavailable after reload." },
  restored: { icon: "history", copy: "Restored text evidence. This does not prove playback or that the current voice engine received it." },
} as const satisfies Record<string, { icon: IconName; copy: string; role?: string }>;

export interface TranscriptQualifiersProps {
  kind: "recognized" | "generated" | "task-request" | "task-result";
  /** Original evidence source, never the current service picker. Absent means unknown. */
  source?: string;
  playback?: "played" | "unknown" | "not-spoken";
  restored?: boolean;
  /** Observed text whose durable write failed; never inferred from playback. */
  unsaved?: boolean;
  orderUnknown?: boolean;
  finish?: "updating" | "some-updating" | "finished" | "unknown";
  evidenceLabel: string;
  children: ReactNode;
}

const finishCopy = {
  updating: "Recognition updating.",
  "some-updating": "Some fragments are still updating.",
  finished: "Service finish marker received. This does not verify the words or speaker.",
  unknown: "No finish evidence.",
} as const;

/** Shared detail shell keeps D54 focus, dismissal and motion in the existing overlay. */
function Details({ open, onClose, title, children, returnFocus, dialogId }: { dialogId?: string; open: boolean; onClose: () => void; title: string; children: ReactNode; returnFocus: () => HTMLElement | null }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const id = useId();
  return <Overlay data-transcript-details="" id={dialogId} open={open} onClose={onClose} variant="dialog" labelledBy={id} initialFocus={heading} returnFocus={returnFocus} closeLabel={`Close ${title.toLowerCase()}`}>
    <div className="bk-transcript-details">
      <h2 id={id} ref={heading} tabIndex={-1}>{title}</h2>
      {children}
    </div>
  </Overlay>;
}

/** One native focus stop per logical blurb, with equivalent hover, focus and tap access. */
export function TranscriptQualifiers(p: TranscriptQualifiersProps) {
  const owner = useContext(ReadingOwner);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 16, top: 16 });
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const suppressed = useRef(false);
  const skipFocus = useRef(false);
  const hovered = useRef(false);
  const anchor = useRef<HTMLElement | null>(null);
  const source = p.source || "source unknown";
  const keys = [p.kind, ...(p.kind === "generated" ? [p.playback ?? "unknown"] : []), ...(p.restored ? ["restored" as const] : []), ...(p.unsaved ? ["unsaved" as const] : [])] as Array<keyof typeof vocabulary>;
  const sentences = keys.map(key => vocabulary[key].copy);
  const name = [vocabulary[p.kind].role, source, ...(p.kind === "recognized" ? ["unverified"] : []), ...(p.kind === "generated" ? [`playback ${p.playback ?? "unknown"}`] : []), ...(p.restored ? ["restored"] : []), ...(p.unsaved ? ["unsaved"] : [])].join("; ") + ". Transcript details.";
  const clear = () => { clearTimeout(pending.current); };
  const hide = () => { clear(); setShown(false); };
  const enter = () => { clear(); suppressed.current = false; pending.current = setTimeout(() => { if (!suppressed.current && !open) setShown(true); }, 300); };
  const leave = () => { clear(); pending.current = setTimeout(() => { if (!hovered.current && trigger.current?.ownerDocument.activeElement !== trigger.current) setShown(false); }, 150); };
  useEffect(() => () => clearTimeout(pending.current), []);
  useLayoutEffect(() => {
    if (!shown) return;
    const node = trigger.current!;
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
  const returnFocus = () => trigger.current?.isConnected ? trigger.current : anchor.current?.isConnected ? anchor.current : owner?.returnFocus() ?? null;
  const portal = trigger.current?.ownerDocument.body;
  return <>
    <button
      // raw-button: kit — Multi-glyph evidence needs focus/hover descriptions without a native title tooltip.
      type="button" ref={trigger} className="bk-control bk-transcript-qualifiers" data-transcript-qualifiers={p.kind}
      aria-label={name} aria-haspopup="dialog" aria-expanded={open} aria-controls={`${id}-details`} aria-describedby={shown ? `${id}-tooltip` : undefined}
      onPointerEnter={event => { if (event.pointerType !== "touch") { hovered.current = true; enter(); } }}
      onPointerLeave={() => { hovered.current = false; leave(); }}
      onFocus={() => { if (trigger.current) owner?.onRead(trigger.current); if (skipFocus.current) { skipFocus.current = false; return; } enter(); }} onBlur={leave}
      onClick={() => { hide(); suppressed.current = true; anchor.current = trigger.current?.closest<HTMLElement>("[data-arrival-key],[data-transcript-anchor]") ?? null; if (trigger.current) owner?.onRead(trigger.current); setOpen(true); }}>
      <span className="bk-transcript-glyphs" aria-hidden="true">{keys.map(key => <Icon key={key} icon={vocabulary[key].icon} size={14} />)}</span>
    </button>
    {portal && shown && createPortal(<div id={`${id}-tooltip`} ref={tooltip} role="tooltip" className="bk-transcript-tooltip" style={{ ...position, colorScheme: getComputedStyle(trigger.current!).colorScheme }}
      onPointerEnter={() => { hovered.current = true; clear(); }} onPointerLeave={() => { hovered.current = false; leave(); }}>
      {sentences.join(" ")} Source: {p.source || "unknown"}. Open transcript details for evidence.
    </div>, portal)}
    {portal && open && createPortal(<div style={{ colorScheme: getComputedStyle(trigger.current!).colorScheme }}><Details dialogId={`${id}-details`} title="Transcript details" open={open} onClose={() => { suppressed.current = true; skipFocus.current = true; setOpen(false); }} returnFocus={returnFocus}>
      <div>
        <p>{vocabulary[p.kind].role}</p>
        <p>{p.kind.startsWith("task-") ? "Execution" : "Source"}: {p.source || "unknown"}</p>
        {sentences.map((copy, i) => <p key={keys[i]}>{copy}</p>)}
        {p.finish && <p>{finishCopy[p.finish]}</p>}
        {p.orderUnknown && <p>Original discussion position unknown; shown in the restored-evidence section.</p>}
        <details><summary>{p.evidenceLabel}</summary>{p.children}</details>
      </div>
    </Details></div>, portal)}
  </>;
}

/** One discoverable legend per existing voice-entry introduction. */
export function TranscriptSymbols() {
  const owner = useContext(ReadingOwner);
  const [open, setOpen] = useState(false);
  const holder = useRef<HTMLSpanElement>(null);
  const focus = () => holder.current?.querySelector<HTMLButtonElement>("button") ?? owner?.returnFocus() ?? null;
  return <span ref={holder} onFocus={() => { const opener = focus(); if (opener) owner?.onRead(opener); }}>
    <TextButton label="Transcript symbols" tone="meta" onClick={() => { const opener = focus(); if (opener) owner?.onRead(opener); setOpen(true); }} />
    {open && <Details title="Transcript symbols" open={open} onClose={() => setOpen(false)} returnFocus={focus}>
      <dl>{Object.entries(vocabulary).map(([key, value]) => <div key={key}><dt><span aria-hidden="true"><Icon icon={value.icon} size={16} /></span> {"role" in value ? value.role : key === "restored" ? "Restored evidence" : key === "unsaved" ? "Unsaved evidence" : `Playback ${key}`}</dt><dd>{value.copy}</dd></div>)}</dl>
      <p>Source names identify the original service, not the speaker. Matching text or received order does not establish a question/reply pair. Permission and recovery controls remain separate.</p>
    </Details>}
  </span>;
}
