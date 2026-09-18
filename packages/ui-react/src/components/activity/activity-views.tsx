import { ActionCard, AgentRunCard, Button, ListRow, Receipt } from "@schlessera/brain-ui-kit";
import type { AgentRunTool, ReceiptRow, RunToolState } from "@schlessera/brain-ui-kit";
import { isFailureOutcome, type ActivityIntent, type ActivitySpanOutcome } from "@schlessera/brain-ui-sdk/protocol";

/**
 * The Activity surface's rows, rendered from props (S7, the `activity`
 * directory). The design's `1c` screen draws a running run as an
 * `AgentRunCard` (the tool strip is "the shortest honest answer to 'is real
 * work happening?'") and the day's history as plain `ListRow`s; `1c`/`2a`
 * draw a thing that needs you as an `ActionCard`. The containers in
 * `activity-run-list.tsx`, `activity-page.tsx` and `activity-run-detail.tsx`
 * read the store and the API; these decide how a row looks.
 */

/** A child span's outcome as the kit's tool-strip state. */
export function toolState(outcome: ActivitySpanOutcome | undefined | null): RunToolState {
  if (outcome === undefined || outcome === null) return "active";
  if (outcome === "success") return "done";
  return isFailureOutcome(outcome) ? "failed" : "idle";
}

export interface LiveRunCardProps {
  name: string;
  /** The step in flight, if the run has steps at all (a plain cron job has none). */
  current: string | null;
  elapsed: string;
  tools: AgentRunTool[];
  onOpen: () => void;
}

/**
 * A running run. The kit card carries no handler of its own — the design
 * draws it as a monitor — so the row is a native button around it, named
 * for what opening it does.
 */
export function LiveRunCard(p: LiveRunCardProps) {
  return (
    <button
      type="button"
      onClick={p.onOpen}
      aria-label={`Open run ${p.name}`}
      className="block w-full rounded-[13px] text-left transition-[filter] hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--bk-focus-ring)]"
    >
      <AgentRunCard
        agent={p.name}
        state="running"
        meta={p.elapsed}
        task={p.current ? `▸ ${p.current}` : undefined}
        progress={null}
        tools={p.tools.length ? p.tools : undefined}
      />
    </button>
  );
}

export interface HistoryRowProps {
  name: string;
  cron: boolean;
  /** The run's outcome, or null while unknown. */
  outcome: ActivitySpanOutcome | null;
  /** Cost, duration and when — already formatted, joined with a middle dot. */
  meta: string;
  onOpen: () => void;
}

export function HistoryRow(p: HistoryRowProps) {
  const failed = isFailureOutcome(p.outcome);
  return (
    <ListRow
      variant="plain"
      icon={p.cron ? "repeat" : "agent"}
      iconTone={failed ? "red" : "neutral"}
      title={p.name}
      subtitle={p.outcome && p.outcome !== "success" ? p.outcome : undefined}
      subMono
      value={p.meta}
      valueTone={failed ? "red" : "neutral"}
      onClick={p.onOpen}
    />
  );
}

export interface IntentCardProps {
  intent: ActivityIntent;
  /** When it was raised, already formatted. */
  when: string;
  onOpen: () => void;
  onDismiss: () => void;
  /** Print `d` on Dismiss: the list binds it while the card holds focus (D36). */
  keyHint?: boolean;
}

/** A thing that needs attention: failure, stuck, or a completion to note. */
export function IntentCard(p: IntentCardProps) {
  const kind = p.intent.kind;
  return (
    <ActionCard
      kind={kind === "failure" ? "dead-letter" : "fyi"}
      icon={kind === "stuck" ? "deadline" : undefined}
      kindLabel={kind === "failure" ? "Failed" : kind === "stuck" ? "Stuck" : "Completed"}
      title={p.intent.title}
      body={p.intent.body || undefined}
      footMeta={p.when}
      footDot={kind === "failure" ? "red" : kind === "stuck" ? "amber" : "teal"}
      footPulse={kind === "stuck"}
      chevron={false}
      onClick={p.onOpen}
    >
      <div className="mt-2 flex justify-end" onClick={(e) => e.stopPropagation()}>
        <Button label={p.keyHint ? "Dismiss · d" : "Dismiss"} tone="quiet" size="sm" block={false} onClick={p.onDismiss} />
      </div>
    </ActionCard>
  );
}

export interface RunRollupReceiptProps {
  origin: string;
  outcome: ActivitySpanOutcome | null;
  when: string;
  duration: string | null;
  listCost: string;
  effectiveCost: string;
  billing: string | null;
  estimated: boolean;
  usage: string | null;
  failureReason: string | null;
}

/** The rollup header of a run's detail: machine facts, key/value, as a `Receipt`. */
export function RunRollupReceipt(p: RunRollupReceiptProps) {
  const failed = isFailureOutcome(p.outcome);
  const rows: ReceiptRow[] = [
    { k: "origin", v: p.origin },
    ...(p.outcome ? [{ k: "outcome", v: p.outcome, tone: failed ? ("red" as const) : ("teal" as const) }] : []),
    { k: "started", v: p.when },
    ...(p.duration ? [{ k: "took", v: p.duration }] : []),
    { k: "list", v: p.listCost },
    { k: "effective", v: `${p.effectiveCost}${p.billing ? ` · ${p.billing}` : ""}${p.estimated ? " · ~ estimated rates" : ""}` },
    ...(p.usage ? [{ k: "usage", v: p.usage }] : []),
  ];
  return (
    <div className="mb-2">
      <Receipt
        title="This run"
        titleIcon="ledger"
        titleTone={failed ? "red" : "teal"}
        rows={rows}
        footnote={p.failureReason ?? ""}
        footIcon={p.failureReason ? "failed" : undefined}
        footTone={p.failureReason ? "red" : undefined}
        keyWidth={66}
      />
    </div>
  );
}
