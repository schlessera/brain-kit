import type {
  InboxActionItem,
  InboxDismissReason,
  InboxItem,
  InboxOption,
  InboxQueueItem,
  InboxThread,
} from "@schlessera/brain-ui-sdk/protocol";
import { inboxOptionSchema } from "@schlessera/brain-ui-sdk/schemas";
import type { EffectPreviewProps } from "@schlessera/brain-ui-kit";

/**
 * Pure view model for durable Actions and the Queue (#684): what each card
 * shows and offers, computed from the mirrored records. Nothing here sends,
 * stores or decides; it only reads.
 */

const DAY = 86_400_000;

/**
 * The read-time priority score, the same formula the server ranks by
 * (`export function inboxPriority(`, `packages/ui-server/src/inbox/state.ts:59-72`). Durable Actions
 * carry no attempts, so the attempts term is zero for them. Parity is
 * asserted against the server's own function in
 * `tests/inbox-actions-stream.test.ts`.
 */
export function decisionPriority(stakes: number, deadline: number | undefined, createdAt: number, attempts: number, now: number): number {
  const remaining = deadline === undefined ? Infinity : deadline - now;
  const urgency = remaining < DAY ? 3 : remaining < 3 * DAY ? 2 : remaining < 7 * DAY ? 1 : 0;
  const age = Math.min(Math.max(Math.floor((now - createdAt) / DAY), 0), 5);
  return 4 * stakes + 3 * urgency + age - Math.min(attempts, 3);
}

/** The terms of the score, for "Why this one". */
export function priorityTerms(thread: InboxThread | undefined, item: InboxActionItem, now: number): string {
  const stakes = thread?.stakes ?? 0;
  const deadline = thread?.deadline;
  const remaining = deadline === undefined ? null : deadline - now;
  const urgency = remaining === null ? "no deadline"
    : remaining < DAY ? "deadline <24h" : remaining < 3 * DAY ? "deadline <72h" : remaining < 7 * DAY ? "deadline <7d" : "deadline later";
  const days = Math.max(0, Math.floor((now - item.createdAt) / DAY));
  return `stakes ${stakes} · ${urgency} · age ${days}d`;
}

export interface DecisionGroup {
  thread: InboxThread | undefined;
  threadId: string;
  items: InboxActionItem[];
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Open decisions grouped by thread (R16). Groups are ordered by their
 * highest-priority member, members by score; ties break by creation time,
 * then id — never by recency of arrival.
 */
export function groupDecisions(items: readonly InboxActionItem[], threads: Record<string, InboxThread>, now: number): DecisionGroup[] {
  const score = new Map<string, number>();
  for (const item of items) {
    const thread = threads[item.threadId];
    score.set(item.id, decisionPriority(thread?.stakes ?? 0, thread?.deadline, item.createdAt, 0, now));
  }
  const byPriority = (a: InboxActionItem, b: InboxActionItem) =>
    score.get(b.id)! - score.get(a.id)! || a.createdAt - b.createdAt || compareIds(a.id, b.id);
  const groups = new Map<string, InboxActionItem[]>();
  for (const item of [...items].sort(byPriority)) {
    const list = groups.get(item.threadId);
    if (list) list.push(item);
    else groups.set(item.threadId, [item]);
  }
  return [...groups.entries()].map(([threadId, list]) => ({ threadId, thread: threads[threadId], items: list }));
}

/** One stored option, classified for display. */
export type OptionView =
  | { role: "commit"; option: InboxOption; effect: EffectPreviewProps; target: string; tool?: string }
  | { role: "dismiss"; option: InboxOption }
  | { role: "later"; option: InboxOption }
  | { role: "unavailable"; option: InboxOption; effect: EffectPreviewProps }
  | { role: "malformed"; option: InboxOption; effect: EffectPreviewProps };

/** Escaped, indented JSON as text. Never markup. */
export function rawText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Classify an option against the STRICT submission schema. The wire reader
 * tolerates additive fields; a card must not offer to approve what the strict
 * schema would not accept, so anything that fails it is shown raw, as text,
 * with its commit disabled.
 */
export function viewOption(option: InboxOption, blockedSubject: string | null): OptionView {
  const parsed = inboxOptionSchema.safeParse(option);
  if (!parsed.success) {
    return {
      role: "malformed",
      option,
      effect: { variant: "malformed", heading: "Effect", message: "This effect can't be displayed.", raw: rawText(option) },
    };
  }
  const effect = parsed.data.effect;
  switch (effect.kind) {
    case "dismiss":
      return { role: "dismiss", option };
    case "snooze":
      return { role: "later", option };
    case "write_policy":
    case "open_session":
      return {
        role: "unavailable",
        option,
        effect: { variant: "unavailable", heading: option.label, effect: effect.kind, message: "Not available in this version." },
      };
    case "cancel_blocked":
      return {
        role: "commit",
        option,
        target: blockedSubject ?? "the blocked work",
        effect: {
          variant: "cancel",
          heading: "If approved",
          effect: "cancel_blocked",
          message: `Cancels queued item ${blockedSubject ?? "blocked on this decision"} and cleans its staging. No tool runs.`,
        },
      };
    case "enqueue": {
      const operation = effect.payload.operation;
      return {
        role: "commit",
        option,
        target: operation ? `${operation.toolName} ${operation.targetPath}` : option.label,
        ...(operation ? { tool: operation.toolName } : {}),
        effect: {
          variant: "enqueue",
          heading: "If approved",
          effect: "enqueue",
          instruction: effect.payload.instruction,
          ...(operation
            ? {
                tool: operation.toolName,
                path: operation.targetPath,
                input: rawText(operation.input),
                scope: `this ${operation.toolName.toLowerCase()}, this path, once`,
              }
            : { scope: "one follow-up turn with no new permission" }),
          cost: "1 autonomous turn",
        },
      };
    }
  }
}

export interface DecisionView {
  commits: Extract<OptionView, { role: "commit" }>[];
  dismiss: Extract<OptionView, { role: "dismiss" }> | null;
  later: Extract<OptionView, { role: "later" }> | null;
  unavailable: Extract<OptionView, { role: "unavailable" }>[];
  malformed: Extract<OptionView, { role: "malformed" }>[];
}

export function viewDecision(action: InboxActionItem, blockedSubject: string | null): DecisionView {
  const view: DecisionView = { commits: [], dismiss: null, later: null, unavailable: [], malformed: [] };
  for (const option of action.options) {
    const v = viewOption(option, blockedSubject);
    if (v.role === "commit") view.commits.push(v);
    else if (v.role === "dismiss") view.dismiss ??= v;
    else if (v.role === "later") view.later ??= v;
    else if (v.role === "unavailable") view.unavailable.push(v);
    else view.malformed.push(v);
  }
  return view;
}

/** The compact card's one-line effect summary: the tool and the full path. */
export function effectSummary(view: DecisionView): string {
  const first = view.commits[0];
  if (first?.tool && first.effect.path) return `${first.tool} · ${first.effect.path}`;
  if (first) return first.effect.variant === "cancel" ? "cancel_blocked · no tool runs" : first.option.label;
  if (view.malformed.length > 0) return "effect can't be displayed";
  return "no effect to approve";
}

export const DISMISS_REASONS: ReadonlyArray<{ id: InboxDismissReason; label: string; description: string }> = [
  { id: "dont_ask_again", label: "Don't ask again", description: "Records feedback; in this version it does not stop future asks." },
  { id: "wrong_call", label: "Wrong call", description: "The question was right; the proposal was not." },
  { id: "need_more_info", label: "Need more info", description: "Re-raise with more context." },
  { id: "no_longer_relevant", label: "No longer relevant", description: "The premise is moot." },
];

export function reasonLabel(reason: InboxDismissReason | undefined): string | null {
  return DISMISS_REASONS.find((r) => r.id === reason)?.label ?? null;
}

/** `verb · target`, the Queue row's subject. */
export function queueSubject(item: InboxQueueItem): string {
  switch (item.type) {
    case "triage":
      return `triage · ${item.payload.stagingId}`;
    case "cleanup_pending":
      return `cleanup · ${item.payload.stagingId}`;
    case "execute": {
      const op = item.payload.operation;
      return op ? `${op.toolName.toLowerCase()} · ${op.targetPath}` : `execute · ${item.payload.instruction}`;
    }
  }
}

export type QueueSection = "blocked" | "running" | "waiting" | "failed";

/** Queue rows that are listed, by section. Done and superseded work is not. */
export function queueSections(items: readonly InboxItem[]): Record<QueueSection, InboxQueueItem[]> {
  const sections: Record<QueueSection, InboxQueueItem[]> = { blocked: [], running: [], waiting: [], failed: [] };
  for (const item of items) {
    if (item.queue !== "queue") continue;
    if (item.status === "blocked") sections.blocked.push(item);
    else if (item.status === "claimed") sections.running.push(item);
    else if (item.status === "ready" || item.status === "scheduled") sections.waiting.push(item);
    else if (item.status === "failed") sections.failed.push(item);
  }
  for (const list of Object.values(sections)) list.sort((a, b) => a.createdAt - b.createdAt || compareIds(a.id, b.id));
  return sections;
}

const WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "Mon 6 Oct, 08:00" in the reader's own zone. */
export function formatWhen(time: number): string {
  return WEEKDAY.format(time).replace(/,(?= \d\d:)/, ",");
}
