import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import type { ClientMessage, InboxActionItem, InboxDismissReason, InboxQueueItem, InboxThread } from "@schlessera/brain-ui-sdk/protocol";
import {
  ActionCard,
  Button,
  IconButton,
  TextButton,
  Callout,
  ChoiceOption,
  Disclosure,
  DispositionBar,
  EffectPreview,
  effectLineCount,
  type DispositionControl,
} from "@schlessera/brain-ui-kit";

import { useBrainUiRoot } from "../../root-context.js";
import { useInboxStore, type InFlightDecision, type InboxOutcome } from "../../stores/inbox-store.js";
import { singleKey } from "../../lib/single-key.js";
import { useUIStore } from "../../stores/ui-store.js";
import { formatRelativeTime } from "../chat/tool-views.js";
import {
  DISMISS_REASONS,
  effectSummary,
  formatWhen,
  queueSubject,
  reasonLabel,
  viewDecision,
  type DecisionView,
} from "./inbox-model.js";

/**
 * Durable Actions in the existing Actions destination (#684).
 *
 * A durable decision is a parked question: the run that asked it was
 * checkpointed and stopped, and nothing waits on it but the queue item it
 * blocks. Its card shows the exact stored effect — tool, path and full input —
 * next to the control that commits it, and changes only when the server says
 * so: a tap puts the card into `Recording…`, and the confirming delta (or a
 * fresh snapshot) decides what it shows next. See the approved design on the
 * issue for the states this file draws.
 */

export const DECISION_CARD = "[data-decision-card]";
/** Ranks 1..FULL_CARDS render in full; the rest are compact. */
export const FULL_CARDS = 10;

export interface DecisionContext {
  thread: InboxThread | undefined;
  /** The queue item blocked on this decision, if any. */
  blocked: InboxQueueItem | null;
  rank: number;
  total: number;
  compact: boolean;
}

type Mode = "idle" | "dismiss" | "later";

function kindLabel(item: InboxActionItem): string {
  return item.type === "choose" ? "Choose" : "Approve?";
}

function provenance(thread: InboxThread | undefined): string | undefined {
  return thread ? `${thread.trustClass} · ${thread.source}` : undefined;
}

/** Send one decision frame and record it, or do nothing at all. */
export function useSendDecision() {
  const root = useBrainUiRoot();
  return (item: InboxActionItem, decision: Omit<InFlightDecision, "state" | "sentVersion">): boolean => {
    const inbox = root.stores.inbox.getState();
    if (!inbox.online || inbox.inFlight[item.id]) return false;
    const frame: ClientMessage = decision.kind === "later"
      ? { type: "inbox_snooze", itemId: item.id }
      : { type: "inbox_resolve", itemId: item.id, optionId: decision.optionId!, ...(decision.reason ? { reason: decision.reason } : {}) };
    if (!root.connection.send(frame)) return false;
    return inbox.beginDecision(item.id, decision);
  };
}

/** The receipt row that replaces a decided card in place. */
export function OutcomeRow({ item, outcome, onQueue }: { item: InboxActionItem; outcome: InboxOutcome; onQueue?: () => void }) {
  let text: string;
  let tone: "teal" | "amber" | "red" | "neutral" = "teal";
  if (outcome.kind === "receipt") {
    const verb = outcome.status === "dismissed" ? "Dismissed" : outcome.status === "snoozed" ? "Snoozed" : "Resolved";
    const until = outcome.waitUntil !== undefined ? ` until ${formatWhen(outcome.waitUntil)}` : "";
    if (outcome.lost) {
      tone = "amber";
      text = `Already ${verb.toLowerCase()} on another device. Your ${outcome.lost} was not applied.`;
    } else if (outcome.by === "elsewhere") {
      text = `${verb} on another device${until} · ${item.payload.title}`;
    } else {
      const reason = reasonLabel(outcome.reason);
      text = `${outcome.text ?? verb}${outcome.status === "snoozed" ? until : ""}${reason ? ` · reason: ${reason.toLowerCase()}` : ""}${outcome.afterReconnect ? " · confirmed after reconnect" : ""}`;
    }
  } else if (outcome.kind === "gone") {
    tone = "neutral";
    text = outcome.status === "dropped" ? `Dropped at the cap (60) · ${item.payload.title}`
      : outcome.status === "expired" ? `Expired · ${item.payload.title}` : `No longer listed · ${item.payload.title}`;
  } else {
    return null;
  }
  return (
    <div data-decision-receipt={item.id} tabIndex={-1} className="flex flex-wrap items-center gap-2 rounded-[12px] border border-border-subtle bg-surface px-3 py-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-primary/50" role="status">
      <span className={tone === "amber" ? "text-primary" : tone === "neutral" ? "text-muted-foreground" : "text-foreground"}>{text}</span>
      {onQueue && outcome.kind === "receipt" && outcome.status === "resolved" && !outcome.lost && (
        <TextButton tone="meta" label="Queue ▸" style={{ marginLeft: "auto" }} onClick={onQueue} />
      )}
    </div>
  );
}

/** What this device knows about an answer it sent. */
function FlightCallout({ flight }: { flight: InFlightDecision }) {
  if (flight.state === "unconfirmed") return <Callout tone="neutral" text="Sent, not confirmed — reconnecting." />;
  if (flight.state === "refused") return <Callout tone="neutral" text="Checking what happened…" />;
  return null;
}

function OutcomeCallout({ outcome }: { outcome: InboxOutcome | undefined }) {
  if (!outcome) return null;
  if (outcome.kind === "not-received") {
    return (
      <div tabIndex={-1} data-decision-alert="" role="alert" className="outline-none">
        <Callout tone="red" text={`Your ${outcome.label} was not received. Nothing was applied.`} />
      </div>
    );
  }
  if (outcome.kind === "not-applied") {
    return (
      <div tabIndex={-1} data-decision-alert="" role="alert" className="outline-none">
        <Callout tone="red" text="Couldn't apply that decision. Nothing changed." />
      </div>
    );
  }
  return null;
}

/**
 * One durable decision. `compact` drops the effect body and the commit
 * control: a compact card's effect is not fully on screen, so it offers only
 * the answers that apply nothing (Later, Dismiss) and its details.
 */
export function DecisionCard({
  item,
  context,
  onDetails,
  onQueue,
  onDecided,
  keys,
}: {
  item: InboxActionItem;
  context: DecisionContext;
  onDetails: () => void;
  onQueue?: (queueItemId: string) => void;
  /** Called once a frame is sent, so the list can move focus on confirmation. */
  onDecided?: (itemId: string) => void;
  keys: boolean;
}) {
  const online = useInboxStore((s) => s.online);
  const flight = useInboxStore((s) => s.inFlight[item.id]);
  const outcome = useInboxStore((s) => s.outcomes[item.id]);
  const change = useInboxStore((s) => s.changes[item.id]);
  const reviewChanges = useInboxStore((s) => s.reviewChanges);
  const send = useSendDecision();
  const view = useMemo<DecisionView>(() => viewDecision(item, context.blocked ? queueSubject(context.blocked) : null), [item, context.blocked]);
  const [mode, setMode] = useState<Mode>("idle");
  const [picked, setPicked] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, true>>({});
  const [reason, setReason] = useState<InboxDismissReason | null>(null);
  const snoozed = item.status === "snoozed";
  const changed = change !== undefined && !change.reviewed;
  const busy = flight !== undefined;
  const lockReason = !online ? "needs the host" : changed ? "Review the changes before answering." : undefined;

  // A new version re-opens nothing half-answered: a confirmation shown for
  // the old version would otherwise commit against the new one.
  useEffect(() => { setMode("idle"); setReason(null); }, [item.version]);

  const commitView = item.type === "choose"
    ? view.commits.find((c) => c.option.id === picked) ?? null
    : view.commits[0] ?? null;
  const gated = commitView?.effect.input !== undefined
    && effectLineCount(commitView.effect.input) > 12 && !revealed[commitView.option.id];

  function sendCommit() {
    if (!commitView) return;
    const verb = item.type === "choose" ? "Applied" : "Approved";
    const target = commitView.effect.path ? `${commitView.tool} → ${commitView.effect.path}` : commitView.option.label;
    const sent = send(item, {
      kind: "commit",
      optionId: commitView.option.id,
      ...(view.commits.length > 1 ? { ambiguous: true } : {}),
      label: item.type === "choose" ? `Apply: ${commitView.option.label}` : "Approve",
      receipt: commitView.effect.variant === "cancel" ? `${verb} · cancelled ${commitView.target}` : `${verb} · queued ${target}`,
    });
    if (sent) onDecided?.(item.id);
  }
  function sendDismiss() {
    if (!view.dismiss) return;
    const sent = send(item, {
      kind: "dismiss", optionId: view.dismiss.option.id, label: "Dismiss", receipt: "Dismissed",
      ...(reason ? { reason } : {}),
    });
    if (sent) { setMode("idle"); onDecided?.(item.id); }
  }
  function sendLater() {
    const sent = send(item, { kind: "later", label: "Later", receipt: "Snoozed" });
    if (sent) { setMode("idle"); onDecided?.(item.id); }
  }

  const commitControl: DispositionControl | undefined = context.compact ? undefined
    : gated && commitView
      ? {
          label: `Review ${effectLineCount(commitView.effect.input)} lines to approve`,
          name: `Review all ${effectLineCount(commitView.effect.input)} lines before approving`,
          disabled: lockReason !== undefined,
          onClick: () => setRevealed((r) => ({ ...r, [commitView.option.id]: true })),
        }
      : item.type === "choose"
        ? {
            label: commitView ? `Apply: ${commitView.option.label}` : "Apply choice",
            name: commitView ? `Apply: ${commitView.target}` : "Apply choice (pick an option first)",
            effect: commitView?.effect.effect,
            disabled: !commitView || lockReason !== undefined,
            onClick: sendCommit,
          }
        : view.commits.length > 0
          ? {
              label: "Approve",
              name: `Approve: ${view.commits[0]!.target}`,
              effect: view.commits[0]!.effect.effect,
              disabled: lockReason !== undefined,
              onClick: sendCommit,
            }
          : view.malformed.length > 0
            ? { label: "Approve", name: "Approve (unavailable: the effect can't be shown)", disabled: true, onClick: () => {} }
            : undefined;
  const laterControl: DispositionControl | undefined = snoozed ? undefined : {
    label: "Later",
    name: `Later: ${item.payload.title}`,
    disabled: lockReason !== undefined,
    onClick: () => setMode("later"),
  };
  const dismissControl: DispositionControl = {
    label: "Dismiss",
    name: `Dismiss: ${item.payload.title}`,
    disabled: !view.dismiss || lockReason !== undefined,
    onClick: () => setMode("dismiss"),
  };
  const reasonText = lockReason
    ?? (view.malformed.length > 0 && view.commits.length === 0 ? "Can't approve what can't be shown." : undefined)
    ?? (!view.dismiss ? "This decision has no dismiss option." : undefined);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // ⏎ on the card itself (not on a control inside it) opens its details.
    if (event.key === "Enter" && event.target === event.currentTarget) {
      event.preventDefault();
      onDetails();
      return;
    }
    if (!keys || mode !== "idle") return;
    const key = singleKey(event);
    if (key !== "a" && key !== "d" && key !== "s") return;
    event.preventDefault();
    if (key === "a") {
      if (context.compact || gated) onDetails();
      else if (commitControl && !commitControl.disabled && !busy) commitControl.onClick?.();
    } else if (key === "d") {
      if (!dismissControl.disabled && !busy) setMode("dismiss");
    } else if (laterControl && !laterControl.disabled && !busy) {
      setMode("later");
    }
  }

  const busySlot = flight ? (flight.kind === "commit" ? "commit" : flight.kind) : undefined;
  const name = `${kindLabel(item)} ${item.payload.title}. ${context.thread ? `${context.thread.trustClass} ${context.thread.source} thread` : "thread"}. Priority ${context.rank} of ${context.total}.`;

  return (
    <div
      data-decision-card=""
      data-decision-id={item.id}
      data-compact={context.compact ? "" : undefined}
      role="group"
      aria-label={name}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="rounded-[14px] outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
    >
      <ActionCard
        kind={item.type === "choose" ? "choose" : "approval"}
        kindLabel={kindLabel(item)}
        title={item.payload.title}
        {...(!context.compact && item.payload.detail ? { body: item.payload.detail } : {})}
        {...(context.compact ? { body: effectSummary(view) } : {})}
        {...(provenance(context.thread) ? { rightChip: provenance(context.thread), rightChipTone: context.thread?.trustClass === "untrusted" ? "amber" as const : "teal" as const } : {})}
        footMeta={`parked ${formatRelativeTime(item.createdAt)}${snoozed && item.waitUntil !== undefined ? ` · already snoozed until ${formatWhen(item.waitUntil)}` : ""}`}
        footDot="neutral"
        chevron={false}
        {...(context.blocked && onQueue ? { footLink: { label: "blocks queue item ▸", name: `Open the queue item blocked on: ${item.payload.title}`, onClick: () => onQueue(context.blocked!.id) } } : {})}
      >
        <div className="flex flex-col gap-2">
          {change && (
            <div data-decision-changed="" className="flex flex-col gap-2">
              <Callout tone="gold" text={`This decision changed while you were reading it. Changed: ${change.fields.join(" · ")}`} />
              {!change.reviewed ? (
                <Button label="Review changes" tone="ghost" size="sm" block={false} style={{ minHeight: 44 }} onClick={() => reviewChanges(item.id)} />
              ) : (
                <ChangeReview before={change.before} after={item} fields={change.fields} />
              )}
            </div>
          )}
          {flight && <FlightCallout flight={flight} />}
          <OutcomeCallout outcome={outcome} />
          {!context.compact && (
            <EffectBody
              item={item}
              view={view}
              picked={picked}
              onPick={setPicked}
              revealed={revealed}
              onReveal={(id) => setRevealed((r) => ({ ...r, [id]: true }))}
              disabled={busy || lockReason !== undefined}
            />
          )}
          {snoozed && (
            <p className="font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground">
              Already snoozed until {item.waitUntil !== undefined ? formatWhen(item.waitUntil) : "its scheduled time"}
            </p>
          )}
          {mode === "dismiss" ? (
            <DismissConfirm
              reason={reason}
              onReason={setReason}
              onConfirm={sendDismiss}
              onKeep={() => { setMode("idle"); setReason(null); }}
              disabled={busy || lockReason !== undefined}
            />
          ) : mode === "later" ? (
            <LaterConfirm onConfirm={sendLater} onCancel={() => setMode("idle")} disabled={busy || lockReason !== undefined} />
          ) : (
            <DispositionBar
              commit={commitControl}
              later={laterControl}
              dismiss={dismissControl}
              busy={busySlot}
              busyLabel="Recording…"
              reason={reasonText}
            />
          )}
          <div className="flex justify-end">
            <TextButton tone="meta" label="Details ▸" ariaLabel={`Details: ${item.payload.title}`} onClick={onDetails} />
          </div>
        </div>
      </ActionCard>
    </div>
  );
}

function EffectBody({
  item, view, picked, onPick, revealed, onReveal, disabled,
}: {
  item: InboxActionItem;
  view: DecisionView;
  picked: string | null;
  onPick: (id: string) => void;
  revealed: Record<string, true>;
  onReveal: (id: string) => void;
  disabled: boolean;
}) {
  const [caret, setCaret] = useState(0);
  if (item.type === "choose") {
    const choices = view.commits;
    // A revision can remove options: keep the one tab stop on a real option.
    const stop = Math.min(caret, Math.max(choices.length - 1, 0));
    return (
      <div className="flex flex-col gap-2">
        <div role="radiogroup" aria-label={`Options: ${item.payload.title}`} className="flex flex-col gap-2">
          {choices.map((choice, i) => (
            <div key={choice.option.id} className="flex flex-col gap-1.5">
              <ChoiceOption
                title={choice.option.label}
                subtitle={choice.effect.path ?? choice.effect.message}
                selected={picked === choice.option.id}
                tabStop={i === stop}
                onFocus={() => setCaret(i)}
                onClick={disabled ? undefined : () => onPick(choice.option.id)}
              />
              <EffectPreview {...choice.effect} heading="If you choose this" revealed={revealed[choice.option.id] === true} onReveal={() => onReveal(choice.option.id)} />
            </div>
          ))}
        </div>
        <ExtraEffects view={view} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {view.commits.map((commit) => (
        <EffectPreview key={commit.option.id} {...commit.effect} revealed={revealed[commit.option.id] === true} onReveal={() => onReveal(commit.option.id)} />
      ))}
      <ExtraEffects view={view} />
    </div>
  );
}

/** Malformed and deferred options: shown, never offered. */
function ExtraEffects({ view }: { view: DecisionView }) {
  return (
    <>
      {view.malformed.map((m) => <EffectPreview key={m.option.id} {...m.effect} />)}
      {view.unavailable.map((u) => (
        <div key={u.option.id} className="flex flex-col gap-1.5">
          <EffectPreview {...u.effect} />
          <Button label={u.option.label} subtitle="Not available in this version" tone="ghost" size="sm" block={false} disabled onClick={() => {}} style={{ minHeight: 44 }} />
        </div>
      ))}
    </>
  );
}

function ChangeReview({ before, after, fields }: { before: InboxActionItem; after: InboxActionItem; fields: string[] }) {
  const rows: ReactNode[] = [];
  if (fields.includes("title")) rows.push(<Pair key="title" label="title" before={before.payload.title} after={after.payload.title} />);
  if (fields.includes("detail")) rows.push(<Pair key="detail" label="detail" before={before.payload.detail} after={after.payload.detail} />);
  if (fields.includes("effect") || fields.includes("options")) {
    rows.push(
      <Pair
        key="effect"
        label="effect"
        before={before.options.map((o) => `${o.label}: ${JSON.stringify(o.effect)}`).join("\n")}
        after={after.options.map((o) => `${o.label}: ${JSON.stringify(o.effect)}`).join("\n")}
      />,
    );
  }
  if (fields.includes("expiry")) rows.push(<Pair key="expiry" label="expiry" before={formatWhen(before.expiresAt)} after={formatWhen(after.expiresAt)} />);
  return <div data-decision-review="" className="flex flex-col gap-1.5">{rows}</div>;
}

function Pair({ label, before, after }: { label: string; before: string; after: string }) {
  return (
    <div className="grid grid-cols-[56px_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[11px]">
      <span className="font-[family-name:var(--font-mono)] text-muted-foreground">{label}</span>
      <span className="whitespace-pre-wrap break-words text-muted-foreground line-through">{before}</span>
      <span />
      <span className="whitespace-pre-wrap break-words text-foreground">{after}</span>
    </div>
  );
}

/** The dismiss confirmation: an optional reason, then one frame. */
function DismissConfirm({
  reason, onReason, onConfirm, onKeep, disabled,
}: {
  reason: InboxDismissReason | null;
  onReason: (reason: InboxDismissReason | null) => void;
  onConfirm: () => void;
  onKeep: () => void;
  disabled: boolean;
}) {
  return (
    <div data-dismiss-confirm="" className="flex flex-col gap-2">
      <p className="text-xs text-foreground">Dismiss this decision?</p>
      <div role="group" aria-label="Dismissal reason (optional · changes no permission)" className="flex flex-wrap gap-2">
        {DISMISS_REASONS.map((r) => (
          <button
            // raw-button: select — pressed dismissal chips; kit Chip is non-interactive
            key={r.id}
            type="button"
            style={{ "--hv-bg": "var(--bk-hover-veil-strong)" } as CSSProperties}
            aria-pressed={reason === r.id}
            aria-description={r.description}
            title={r.description}
            disabled={disabled}
            onClick={() => onReason(reason === r.id ? null : r.id)}
            className={
              "bk-row min-h-11 rounded-full border px-3 text-xs transition-colors " +
              (reason === r.id ? "border-primary bg-primary/10 text-foreground" : "border-border-subtle text-muted-foreground hover:text-foreground")
            }
          >
            {r.label}
          </button>
        ))}
      </div>
      <p className="text-[10px] text-muted-foreground">Optional feedback. A reason never grants or stops anything.</p>
      <DispositionBar
        commit={{ label: "Dismiss", name: reason ? `Dismiss with reason: ${reasonLabel(reason)}` : "Dismiss with no reason", disabled, onClick: onConfirm }}
        dismiss={{ label: "Keep", name: "Keep this decision", onClick: onKeep }}
      />
    </div>
  );
}

/**
 * Later, previewed before it commits. The snooze rule is the server's and is
 * not exported to clients, so the preview says when in words and the receipt
 * prints the server's actual time (ruling R1).
 */
function LaterConfirm({ onConfirm, onCancel, disabled }: { onConfirm: () => void; onCancel: () => void; disabled: boolean }) {
  return (
    <div data-later-confirm="" className="flex flex-col gap-2">
      <Callout tone="neutral" text="Later → back at the next scheduled time" />
      <DispositionBar
        commit={{ label: "Snooze", name: "Snooze until the next scheduled time", disabled, onClick: onConfirm }}
        dismiss={{ label: "Cancel", name: "Cancel snooze", onClick: onCancel }}
      />
    </div>
  );
}

/** FYIs: static notes, no role, no tab stop. */
export function NoteCard({ item }: { item: InboxActionItem }) {
  return (
    <div data-note-card="">
      <ActionCard kind="fyi" title={item.payload.title} body={item.payload.detail} footMeta={formatRelativeTime(item.createdAt)} chevron={false} />
    </div>
  );
}

/**
 * Keep the order still while an answer is in flight: deltas update cards in
 * place, and new arrivals wait behind a "n new · show" row (design §3).
 */
export function useStableOrder(open: string[], keep: string[], busy: boolean): { order: string[]; fresh: number; show: () => void } {
  const frozen = useRef<string[]>(open);
  const [, force] = useState(0);
  const release = useRef(false);
  const visible = new Set([...open, ...keep]);
  let order: string[];
  if (busy && !release.current) {
    order = frozen.current.filter((id) => visible.has(id));
  } else {
    release.current = false;
    order = [...open];
    for (const [i, id] of frozen.current.entries()) {
      if (keep.includes(id) && !order.includes(id)) order.splice(Math.min(i, order.length), 0, id);
    }
  }
  for (const id of keep) if (!order.includes(id)) order.push(id);
  const fresh = open.filter((id) => !order.includes(id)).length;
  frozen.current = order;
  return {
    order,
    fresh,
    show: () => {
      release.current = true;
      force((n) => n + 1);
    },
  };
}

/** Thread header: the thread's provenance and how many open decisions it holds. */
export function ThreadHeader({ thread, count }: { thread: InboxThread | undefined; count: number }) {
  const label = thread?.stateMd.split("\n").find((line) => line.trim().length > 0)?.replace(/^#+\s*/, "").trim();
  return (
    <p className="mt-1 font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground" data-thread-header="">
      ▸ {label || "Thread"}{thread ? ` · ${thread.trustClass} · ${thread.source}` : ""} · {count}
    </p>
  );
}

/** The decision a reader opened, with the evidence behind its rank. */
export function DecisionDetail({
  item, context, why, onBack, onQueue, onDecided,
}: {
  item: InboxActionItem | undefined;
  context: DecisionContext | null;
  why: string;
  onBack: () => void;
  onQueue: (queueItemId: string) => void;
  onDecided?: (itemId: string) => void;
}) {
  const keys = useUIStore((s) => s.singleKeyShortcuts);
  const outcome = useInboxStore((s) => (item ? s.outcomes[item.id] : undefined));
  const thread = context?.thread;
  const open = item && (item.status === "pending" || item.status === "snoozed");
  return (
    <div className="flex h-full flex-col overflow-y-auto" data-decision-detail="">
      <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
        <span className="laptop:hidden">
          <IconButton size="md" name="Back to Actions" icon="back" onClick={onBack} />
        </span>
        <h1 className="min-w-0 flex-1 break-words text-sm font-medium" tabIndex={-1} data-destination-heading="">{item?.payload.title ?? "Decision"}</h1>
      </div>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
        {item && !open && outcome && <OutcomeRow item={item} outcome={outcome} />}
        {!item || !open ? (
          <p className="text-xs text-muted-foreground outline-none" role="status" tabIndex={-1} data-decision-detail-status="">
            {item?.status === "dropped" || outcome?.kind === "gone" && outcome.status === "dropped"
              ? "Dropped at the cap (60) · lower priority than every open decision"
              : item?.status === "expired" ? "Expired · no longer answerable"
              : item ? `This decision is ${item.status}.` : "This decision is no longer listed."}
          </p>
        ) : context ? (
          <DecisionCard key={item.id} item={item} context={{ ...context, compact: false }} onDetails={() => {}} onQueue={onQueue} onDecided={onDecided} keys={keys} />
        ) : null}
        {item && (
          <section className="flex flex-col gap-1.5">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Why this one</h2>
            <p className="font-[family-name:var(--font-mono)] text-[11px] text-foreground">{why}</p>
          </section>
        )}
        {thread && thread.stateMd.trim() && (
          <Disclosure label={`Agent's notes (${thread.trustClass} source, plain text) · ${thread.stateMd.split("\n").length} lines`}>
            <pre className="whitespace-pre-wrap break-words text-[11px] text-foreground">{thread.stateMd}</pre>
          </Disclosure>
        )}
      </div>
    </div>
  );
}
