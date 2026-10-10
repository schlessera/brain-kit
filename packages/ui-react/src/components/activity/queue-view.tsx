import { useEffect, useMemo } from "react";
import type { InboxActionItem, InboxQueueItem } from "@schlessera/brain-ui-sdk/protocol";
import { IconButton, QueueItemRow, Receipt } from "@schlessera/brain-ui-kit";

import { useInboxStore } from "../../stores/inbox-store.js";
import { formatRelativeTime } from "../chat/tool-views.js";
import { formatWhen, queueSections, queueSubject, type QueueSection } from "./inbox-model.js";

/**
 * The secondary, read-only Queue (#684): the agent's side of the loop as
 * fact. It is a pushed view inside Actions — never a lens, tab or destination
 * — reached from the header, the running lens and each blocking card. There
 * are no claim, retry or cancel controls here: cancelling blocked work is an
 * option on the decision that blocks it.
 */

const SECTIONS: ReadonlyArray<{ id: QueueSection; label: string }> = [
  { id: "blocked", label: "Blocked" },
  { id: "running", label: "Running" },
  { id: "waiting", label: "Waiting" },
  { id: "failed", label: "Failed" },
];

/** How many queue items are listed, and the running-lens footer counts. */
export function useQueueCounts(): { total: number; ready: number; blocked: number; failed: number } {
  const items = useInboxStore((s) => s.items);
  return useMemo(() => {
    const sections = queueSections(Object.values(items));
    return {
      total: sections.blocked.length + sections.running.length + sections.waiting.length + sections.failed.length,
      ready: sections.waiting.length,
      blocked: sections.blocked.length,
      failed: sections.failed.length,
    };
  }, [items]);
}

function rowFacts(item: InboxQueueItem, now: number): { meta?: string; note?: string } {
  switch (item.status) {
    case "claimed":
      return { meta: item.leaseUntil !== undefined ? `lease ${Math.max(0, Math.round((item.leaseUntil - now) / 60_000))}m left` : "claimed" };
    case "scheduled":
      return { meta: formatRelativeTime(item.createdAt), note: item.waitUntil !== undefined ? `waits until ${formatWhen(item.waitUntil)}` : undefined };
    case "failed":
      return { meta: formatRelativeTime(item.updatedAt), note: `${item.attempts} / ${item.maxAttempts} attempts · dead-lettered` };
    case "blocked":
      return { meta: formatRelativeTime(item.updatedAt), note: "waits on your decision" };
    default:
      return { meta: formatRelativeTime(item.createdAt) };
  }
}

export function QueueView({
  focusId,
  onBack,
  onOpenAction,
  onOpenItem,
}: {
  /** A row to scroll to and focus on arrival. */
  focusId: string | null;
  onBack: () => void;
  /** A blocked row's link: back to the decision it waits on. */
  onOpenAction: (actionId: string) => void;
  /** Any other row: its run, its rollup, or its item receipt. */
  onOpenItem: (item: InboxQueueItem) => void;
}) {
  const items = useInboxStore((s) => s.items);
  const online = useInboxStore((s) => s.online);
  const sections = useMemo(() => queueSections(Object.values(items)), [items]);
  const total = SECTIONS.reduce((n, s) => n + sections[s.id].length, 0);
  const now = Date.now();

  useEffect(() => {
    if (!focusId) return;
    const row = document.querySelector<HTMLElement>(`[data-queue-row="${CSS.escape(focusId)}"] [role="button"]`);
    row?.scrollIntoView({ block: "nearest" });
    row?.focus();
  }, [focusId]);
  useEffect(() => {
    if (focusId) return;
    document.querySelector<HTMLElement>("[data-queue-heading]")?.focus();
  }, [focusId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-queue-view="">
      <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
        <IconButton size="md" name="Back to Actions" icon="back" onClick={onBack} />
        <h1 className="text-sm font-medium outline-none" tabIndex={-1} data-queue-heading="" data-destination-heading="">Queue</h1>
        <span className="ml-auto font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground">{total} items</span>
      </div>
      <div className="flex flex-col gap-4 p-4">
        {!online && (
          <p className="font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground" role="status">Reconnecting · this may be out of date</p>
        )}
        {total === 0 && <QueueItemRow view="empty" />}
        {SECTIONS.map(({ id, label }) => sections[id].length > 0 && (
          <section key={id} aria-label={`${label} · ${sections[id].length}`} className="flex flex-col gap-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label} · {sections[id].length}</h2>
            {sections[id].map((item) => {
              const blocker = item.blockedByItemId ? items[item.blockedByItemId] : undefined;
              const action = blocker?.queue === "actions" ? (blocker as InboxActionItem) : undefined;
              const facts = rowFacts(item, now);
              return (
                <div key={item.id} data-queue-row={item.id}>
                  <QueueItemRow
                    state={item.status === "claimed" || item.status === "blocked" || item.status === "ready" || item.status === "scheduled" || item.status === "failed" ? item.status : "superseded"}
                    subject={queueSubject(item)}
                    {...(facts.meta ? { meta: facts.meta } : {})}
                    {...(facts.note ? { note: facts.note } : {})}
                    {...(action ? { link: action.payload.title } : {})}
                    onClick={() => (action ? onOpenAction(action.id) : onOpenItem(item))}
                  />
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}

/** A queue item with no run yet: its record, as a receipt. */
export function QueueItemReceipt({ item, onBack }: { item: InboxQueueItem; onBack: () => void }) {
  const thread = useInboxStore((s) => s.threads[item.threadId]);
  return (
    <div className="flex h-full flex-col overflow-y-auto" data-queue-receipt="">
      <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
        <span className="laptop:hidden">
          <IconButton size="md" name="Back to Queue" icon="back" onClick={onBack} />
        </span>
        <h1 className="min-w-0 flex-1 break-words text-sm font-medium" tabIndex={-1} data-destination-heading="">{queueSubject(item)}</h1>
      </div>
      <div className="p-4">
        <Receipt
          title="Queue item"
          rows={[
            { k: "subject", v: queueSubject(item) },
            { k: "state", v: item.status },
            { k: "attempts", v: `${item.attempts} / ${item.maxAttempts}` },
            ...(item.leaseUntil !== undefined ? [{ k: "lease", v: formatWhen(item.leaseUntil) }] : []),
            { k: "created", v: formatWhen(item.createdAt) },
            { k: "dedup", v: item.dedupKey },
            { k: "thread", v: thread ? `${item.threadId} · ${thread.trustClass} · ${thread.source}` : item.threadId },
          ]}
          footnote="No run yet: this item has not been claimed."
        />
      </div>
    </div>
  );
}
