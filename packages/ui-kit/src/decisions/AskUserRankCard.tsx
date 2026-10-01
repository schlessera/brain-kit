import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { AskUserListItem } from "./AskUserListCard.js";
import { DecisionRowText } from "./DecisionRow.js";
import { Button } from "../primitives/Button.js";
import { Icon } from "../primitives/Icon.js";
import { InlineToast } from "../conversation/InlineToast.js";
import { accent, color, font, token } from "../tokens.js";

export interface AskUserRankSubmission { order: string[]; unchanged: boolean }
export interface AskUserRankCardProps {
  id?: string;
  state?: "pending" | "answered" | "dismissed";
  prompt?: string;
  question: string;
  items: AskUserListItem[];
  cutoff?: number;
  order?: string[];
  unchanged?: boolean;
  answerMeta?: string;
  lapsedNote?: string;
  singleKeys?: boolean;
  onSubmit?: (result: AskUserRankSubmission) => void;
  onDismiss?: () => void;
  onAskAgain?: () => void;
}

export function moveRankItem(order: readonly string[], id: string, position: number): string[] {
  const next = order.filter((item) => item !== id);
  next.splice(Math.max(0, Math.min(position, next.length)), 0, id);
  return next;
}
function transcriptScroller(root: HTMLElement): HTMLElement | null {
  for (let node = root.parentElement; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}
type Move = { id: string; before: string[] };
type Drag = Move & { pointerId: number; capture: HTMLDivElement; y: number; offset: number; scroller: HTMLElement | null; overscroll: string; frame: number };

/** One exchange, one action row. Tap-to-move is equal to handle dragging. */
export function AskUserRankCard(p: AskUserRankCardProps) {
  return <RankList {...p} embedded={false} />;
}
export interface RankListProps extends AskUserRankCardProps {
  embedded?: boolean;
  onChange?: (value: AskUserRankSubmission) => void;
  onMoveChange?: (label: string | null) => void;
}
export function RankList(p: RankListProps) {
  const embedded = p.embedded !== false;
  const generated = useId();
  const id = p.id ?? generated;
  const state = p.state ?? "pending";
  const initial = p.items.map((item) => item.id);
  const [order, setOrder] = useState(() => p.order ?? initial);
  const orderRef = useRef(order);
  orderRef.current = order;
  const [picked, setPicked] = useState<Move | null>(null);
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const drag = useRef<Drag | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(initial[0]);
  const [live, setLive] = useState("");
  const [undo, setUndo] = useState<string[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const positions = useRef(new Map<string, number>());
  const digits = useRef({ value: "", at: 0 });
  const changed = !initial.every((item, index) => order[index] === item);
  const itemMap = new Map(p.items.map((item) => [item.id, item]));
  const name = (item: string) => itemMap.get(item)?.label ?? item;
  const count = p.cutoff ?? p.items.length;

  function row(item: string) { return [...(rows.current?.querySelectorAll<HTMLElement>("[data-rank-row]") ?? [])].find((node) => node.dataset.rankRow === item); }
  function focus(item: string) { setFocused(item); row(item)?.querySelector<HTMLButtonElement>("[data-rank-pick]")?.focus({ preventScroll: true }); }
  function apply(next: string[]) {
    orderRef.current = next; setOrder(next);
    p.onChange?.({ order: [...next], unchanged: initial.every((id, i) => next[i] === id) });
  }
  function changePicked(move: Move | null) {
    pickedRef.current = move; setPicked(move);
    p.onMoveChange?.(move ? name(move.id) : null);
  }
  function announce(item: string, before: string[], next: string[]) {
    const position = next.indexOf(item) + 1;
    const dropped = p.cutoff ? before.slice(0, p.cutoff).find((candidate) => !next.slice(0, p.cutoff).includes(candidate)) : undefined;
    setLive(`${name(item)} moved to ${position} of ${p.items.length}.${dropped ? ` ${name(dropped)} dropped below the top ${p.cutoff}.` : ""}`);
  }
  function cleanupDrag() {
    const current = drag.current;
    drag.current = null;
    if (!current) return;
    cancelAnimationFrame(current.frame);
    if (current.scroller) current.scroller.style.overscrollBehavior = current.overscroll;
    const node = row(current.id);
    if (node) node.style.transform = "";
    if (current.capture.hasPointerCapture(current.pointerId)) current.capture.releasePointerCapture(current.pointerId);
  }
  function cancel() {
    const move = drag.current ?? pickedRef.current;
    if (!move) return;
    cleanupDrag();
    apply(move.before);
    changePicked(null);
    setLive(`Move cancelled. ${name(move.id)} stays at ${move.before.indexOf(move.id) + 1}.`);
    focus(move.id);
  }
  useEffect(() => () => cleanupDrag(), []);

  function pickup(item: string) {
    setUndo(null);
    const move = pickedRef.current;
    if (move) {
      if (move.id === item) { cancel(); return; }
      const next = moveRankItem(orderRef.current, move.id, orderRef.current.indexOf(item));
      apply(next); changePicked(null); announce(move.id, move.before, next); focus(move.id);
    } else {
      const next = { id: item, before: [...orderRef.current] };
      pickedRef.current = next; changePicked(next); setFocused(item);
      setLive(`${name(item)} picked up, position ${orderRef.current.indexOf(item) + 1} of ${p.items.length}. Tap or arrow to where it should go.`);
    }
  }
  function drop() {
    const move = drag.current ?? pickedRef.current;
    if (!move) return;
    cleanupDrag(); changePicked(null);
    announce(move.id, move.before, orderRef.current); focus(move.id);
  }
  function updateDrag(reorder = true) {
    const current = drag.current;
    const list = rows.current;
    if (!current || !list) return;
    const top = list.getBoundingClientRect().top;
    const nodes = [...list.querySelectorAll<HTMLElement>("[data-rank-row]")];
    const lifted = row(current.id);
    const center = current.y - current.offset + (lifted?.offsetHeight ?? 0) / 2;
    let destination = orderRef.current.indexOf(current.id);
    const middle = (index: number) => top + nodes[index]!.offsetTop + nodes[index]!.offsetHeight / 2;
    // Cross a neighbour's centre; after a swap its new centre is behind the
    // pointer. This keeps unequal-height rows from oscillating under a still finger.
    if (destination > 0 && center < middle(destination - 1)) {
      while (destination > 0 && center < middle(destination - 1)) destination--;
    } else {
      while (destination < nodes.length - 1 && center > middle(destination + 1)) destination++;
    }
    if (reorder && orderRef.current.indexOf(current.id) !== destination) apply(moveRankItem(orderRef.current, current.id, destination));
    const node = row(current.id);
    if (node) {
      const y = Math.max(0, Math.min(current.y - top - current.offset, list.offsetHeight - node.offsetHeight));
      node.style.transform = `translateY(${y - node.offsetTop}px)`;
    }
  }
  useLayoutEffect(() => {
    for (const node of rows.current?.querySelectorAll<HTMLElement>("[data-rank-row]") ?? []) {
      const key = node.dataset.rankRow!;
      const previous = positions.current.get(key);
      if (previous !== undefined && previous !== node.offsetTop && key !== drag.current?.id && node.animate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        node.animate([{ transform: `translateY(${previous - node.offsetTop}px)` }, { transform: "translateY(0)" }], { duration: 150, easing: "cubic-bezier(.16,1,.3,1)" });
      }
      positions.current.set(key, node.offsetTop);
    }
    if (drag.current) updateDrag(false);
  }, [order]);
  function startDrag(event: PointerEvent<HTMLButtonElement>, item: string) {
    if (event.button !== 0 || event.isPrimary === false) return;
    event.stopPropagation();
    if (pickedRef.current) cancel();
    const node = row(item);
    if (!node || !root.current) return;
    const scroller = transcriptScroller(root.current);
    const current: Drag = { id: item, before: [...orderRef.current], pointerId: event.pointerId, capture: root.current, y: event.clientY, offset: event.clientY - node.getBoundingClientRect().top, scroller, overscroll: scroller?.style.overscrollBehavior ?? "", frame: 0 };
    drag.current = current;
    pickedRef.current = current; changePicked(current); setUndo(null);
    if (scroller) scroller.style.overscrollBehavior = "contain";
    current.capture.setPointerCapture(event.pointerId);
    const tick = () => {
      if (drag.current !== current) return;
      if (scroller && root.current) {
        const bounds = scroller.getBoundingClientRect();
        const card = root.current.getBoundingClientRect();
        const up = current.y < bounds.top + 48 && card.top < bounds.top;
        const down = current.y > bounds.bottom - 48 && card.bottom > bounds.bottom;
        const delta = up ? -Math.min(12, Math.max(0, bounds.top + 48 - current.y) / 4) : down ? Math.min(12, Math.max(0, current.y - bounds.bottom + 48) / 4) : 0;
        const clamped = delta < 0 ? Math.max(delta, card.top - bounds.top) : Math.min(delta, card.bottom - bounds.bottom);
        if (delta) scroller.scrollTop += clamped;
      }
      updateDrag(); current.frame = requestAnimationFrame(tick);
    };
    current.frame = requestAnimationFrame(tick);
  }
  function key(event: KeyboardEvent<HTMLButtonElement>, item: string) {
    if (event.metaKey || event.ctrlKey || event.target !== event.currentTarget) return;
    const index = orderRef.current.indexOf(item);
    const move = pickedRef.current;
    const arrows = event.key === "ArrowUp" || event.key === "ArrowDown";
    if (event.key === "Escape" && move) { event.preventDefault(); cancel(); return; }
    if (event.key === " " || event.key === "Enter") { event.preventDefault(); if (move) drop(); else pickup(item); return; }
    const letter = p.singleKeys !== false && !event.altKey && (event.key === "j" || event.key === "k");
    if (arrows || letter || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const destination = event.key === "Home" ? 0 : event.key === "End" ? order.length - 1 : Math.max(0, Math.min(order.length - 1, index + (event.key === "ArrowUp" || event.key === "k" ? -1 : 1)));
      if (move || event.altKey) {
        const before = orderRef.current;
        const next = moveRankItem(before, item, destination); apply(next); setUndo(null); focus(item);
        if (move) setLive(`Position ${destination + 1} of ${p.items.length}`); else announce(item, before, next);
      } else focus(orderRef.current[destination]!);
    } else if (p.singleKeys !== false && !event.altKey && /^[0-9]$/.test(event.key)) {
      event.preventDefault();
      const now = Date.now();
      const value = now - digits.current.at < 600 ? digits.current.value + event.key : event.key;
      digits.current = { value, at: now };
      let destination = Number(value);
      if (destination < 1 || destination > order.length) { digits.current.value = event.key; destination = Number(event.key); }
      if (destination < 1 || destination > order.length) return;
      const before = orderRef.current;
      const next = moveRankItem(before, item, destination - 1); apply(next); setUndo(null); focus(item);
      if (move) setLive(`Position ${destination} of ${p.items.length}`); else announce(item, before, next);
    }
  }

  const shell = { background: color.surface, border: `1px solid ${token(state === "dismissed" ? "ask-border-gold" : "ask-border-teal")}`, borderRadius: 14, padding: 13 };
  const head = { display: "flex", alignItems: "center", gap: 6, font: `500 10.5px/1.5 ${font.mono}`, color: state === "dismissed" ? accent.gold.ink : accent.teal.ink, textTransform: "uppercase" as const };
  const recorded = p.order ?? initial;
  const displayed = state === "answered" ? recorded : order;
  const visibleCount = state === "answered" && p.items.length >= 8 && !expanded ? p.cutoff ?? 5 : displayed.length;
  return (
    <div ref={root} className="bk-askrank" style={embedded ? { minWidth: 0 } : shell} role="group" aria-labelledby={embedded ? undefined : `${id}-question`} aria-label={embedded ? p.question : undefined} data-state={state} data-embedded={embedded ? "" : undefined}
      onPointerDownCapture={(event) => { if (drag.current && event.pointerId !== drag.current.pointerId) cancel(); }}
      onPointerMove={(event) => { if (drag.current?.pointerId === event.pointerId) drag.current.y = event.clientY; }}
      onPointerUp={(event) => { if (drag.current?.pointerId === event.pointerId) { drag.current.y = event.clientY; updateDrag(); drop(); } }}
      onPointerCancel={cancel} onLostPointerCapture={() => { if (drag.current) cancel(); }}>
      {!embedded ? <div style={head} data-rank-head=""><Icon icon={state === "answered" ? "resolved" : state === "dismissed" ? "later" : "ask"} size={13} />
        {state === "answered" ? `Answered · ${p.unchanged ? "Kept brain’s order" : p.cutoff ? `Top ${p.cutoff} chosen` : `Ranked ${p.items.length}`}` : p.prompt ?? (state === "dismissed" ? "Unanswered — the turn ended" : "Brain needs your input")}
      </div> : null}
      {!embedded ? <p id={`${id}-question`} style={{ margin: "10px 0", font: `500 13px/1.5 ${font.body}`, color: color.ink, overflowWrap: "anywhere" }}>{p.question}</p> : null}
      {state === "dismissed" ? (
        <div className="bk-rank-lapsed"><span>{p.lapsedNote ?? "Dismissed"}</span>{p.onAskAgain ? <Button label="Ask again" tone="quiet" size="sm" block={false} onClick={p.onAskAgain} /> : null}</div>
      ) : (
        <>
          {state === "pending" && !embedded && (!changed || !!drag.current) ? <p className="bk-rank-instructions">Drag the handle or tap an item, then tap where it should go.</p> : null}
          <div className={state === "answered" ? "bk-rank-record" : undefined}>
          <div ref={rows} className="bk-rank-rows" role="list" aria-label={p.question}>
            {displayed.slice(0, visibleCount).map((item, index) => {
              const entry = itemMap.get(item);
              if (!entry) return null;
              const lifted = picked?.id === item;
              const unranked = p.cutoff !== undefined && index >= p.cutoff;
              const accessible = `${entry.label}, position ${index + 1} of ${p.items.length}${lifted ? ", picked up" : unranked ? ", not ranked" : ""}`;
              return <Fragment key={item}><div role="listitem" data-rank-row={item} data-picked={lifted ? "" : undefined} className="bk-rank-row"
                onClick={(event) => { if (state === "pending" && !(event.target as HTMLElement).closest("a,[data-rank-handle]")) pickup(item); }}>
                <span className="bk-rank-position" aria-hidden="true">{lifted ? "●" : unranked ? "–" : index + 1}</span>
                {state === "answered" ? <span className="bk-rank-label">{entry.label}</span> : <>
                  <DecisionRowText item={entry} detailId={`${id}-detail-${index}`} label={<button type="button" data-rank-pick="" className="bk-rank-pick" tabIndex={focused === item ? 0 : -1} aria-label={accessible} aria-describedby={entry.detail ? `${id}-detail-${index}` : undefined} onFocus={() => setFocused(item)} onKeyDown={(event) => key(event, item)}>{entry.label}</button>} />
                  <button type="button" tabIndex={-1} data-rank-handle="" className="bk-rank-handle bk-control" aria-label={`Reorder ${accessible}`}
                    onClick={(event) => { event.stopPropagation(); }} onKeyDown={(event) => key(event, item)}
                    onPointerDown={(event) => startDrag(event, item)}><Icon icon="reorder" size={16} /></button>
                </>}
              </div>
                {p.cutoff === index + 1 ? <div role="presentation" className="bk-rank-cutoff">only {state === "answered" ? "the" : "your"} top {p.cutoff} {state === "answered" ? "counted" : "count"}</div> : null}
              </Fragment>;
            })}
          </div>
            {visibleCount < displayed.length ? <button className="bk-rank-disclosure" type="button" aria-expanded={expanded} onClick={() => setExpanded(true)}>Show {displayed.length - visibleCount} {p.cutoff ? "not ranked" : "more, in order"}</button> : null}
            {state === "answered" ? <span className="bk-rank-meta">{p.answerMeta ?? `you ${p.unchanged ? "kept this order" : `ranked ${count}`}`}</span> : null}
          </div>
          {state === "pending" && embedded ? <div className="bk-rank-hint">
            {picked ? <><span>Tap where {name(picked.id)} should go</span><Button label="Cancel" tone="quiet" size="sm" block={false} onClick={cancel} /></> : <>
              {undo ? <InlineToast text="Order reset" target="" effect="" tone="teal" icon="confirm" onUndo={() => { apply(undo); setUndo(null); setLive("Previous order restored."); }} /> : <span>Drag the handle or tap an item, then tap where it should go.</span>}
              {changed ? <Button label="Reset" tone="quiet" size="sm" block={false} onClick={() => { setUndo([...orderRef.current]); apply(initial); setLive("Brain’s order restored. Undo available."); }} /> : null}
            </>}
          </div> : null}
          {state === "pending" && !embedded ? <div className="bk-rank-actions" data-rank-actions="">
            {picked ? <><span>Tap where {name(picked.id)} should go</span><Button label="Cancel" tone="quiet" size="sm" block={false} onClick={cancel} /></> : <>
              {undo ? <InlineToast text="Order reset" tone="teal" icon="confirm" onUndo={() => { apply(undo); setUndo(null); setLive("Previous order restored."); }} /> : null}
              <span className="bk-rank-keys" aria-hidden="true">space pick up · ↑↓ move{p.singleKeys !== false ? " · 1–9 place" : ""}</span>
              <div className="bk-rank-buttons">{!embedded ? <Button label="Dismiss" tone="quiet" size="sm" block={false} onClick={p.onDismiss} /> : null}
                {changed ? <Button label="Reset" tone="quiet" size="sm" block={false} onClick={() => { setUndo([...orderRef.current]); apply(initial); setLive("Brain’s order restored. Undo available."); }} /> : null}
                {!embedded ? <Button label={changed ? "Submit order" : "Keep this order"} tone="affirm" size="sm" block={false} onClick={() => p.onSubmit?.({ order: [...orderRef.current], unchanged: !changed })} /> : null}</div>
            </>}
          </div> : null}
        </>
      )}
      <div aria-live="polite" className="bk-rank-live">{live}</div>
    </div>
  );
}
