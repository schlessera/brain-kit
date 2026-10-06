/**
 * The `ask_user_list` exchange (#583): one kit `AskUserListCard` for the whole
 * list, never one card per item.
 *
 * Three states, all of them kept in the transcript at full contrast:
 *
 *   `pending`   — every item with its chips, one Submit. The card keeps its
 *                 own picks until Submit; what leaves it is the answers keyed
 *                 by item id and any notes, sent as `ask_user_list_response`.
 *   `answered`  — the record, grouped by option. Rebuilt on reload from the
 *                 tool call's input and its persisted result, so a resumed
 *                 transcript shows the same summary.
 *   `dismissed` — the list the turn outlived, with "Ask again". As with
 *                 `ask_user`, the server-side request is already resolved, so
 *                 a reopened card answers by an ordinary composer message
 *                 (`onReask`) that quotes the prompt and each answer.
 *
 * There is no `typed` state: a composer message sent while a list is pending
 * is not bound to it — one line of text cannot answer thirty items — so it
 * travels as an ordinary message, as it does for a multi-question `ask_user`.
 */

import { useState } from "react";
import { AskUserListCard as KitAskUserListCard } from "@schlessera/brain-ui-kit";
import type { AskUserListSpec } from "@schlessera/brain-ui-sdk/protocol";

import { useBrainUiRoot } from "../../root-context.js";
import { useUIStore } from "../../stores/ui-store.js";
import { formatRelativeTime } from "../../lib/format-time.js";
import { DISMISSED_NOTE } from "./ask-user-card.js";
import type { RecordHead } from "./answer-text.js";

/** "you answered 7 · 3m ago", or without the time when none is known. */
export function listAnsweredMeta(count: number, total: number, answeredAt: number | undefined): string {
  const what = count === total ? `you answered ${count}` : `you answered ${count} of ${total}`;
  return answeredAt === undefined ? what : `${what} · ${formatRelativeTime(answeredAt)}`;
}

/**
 * The composer message a reopened list sends: the prompt, then one line per
 * item that got an answer (and any note), then the ones left open.
 */
export function listReaskMessage(
  list: Pick<AskUserListSpec, "prompt" | "items">,
  answers: Record<string, string>,
  notes: Record<string, string> = {}
): string {
  const lines = [`Answering “${list.prompt}”:`];
  const skipped: string[] = [];
  for (const item of list.items) {
    const note = notes[item.id] ? ` (${notes[item.id]})` : "";
    if (Object.hasOwn(answers, item.id)) lines.push(`- ${item.label}: ${answers[item.id]}${note}`);
    else skipped.push(`${item.label}${note}`);
  }
  if (skipped.length) lines.push(`Skipped: ${skipped.join(", ")}`);
  return lines.join("\n");
}

export function AskUserListExchangeCard({
  record,
  requestId,
  list,
  answered,
  notes,
  cancelled,
  answeredAt,
  onSubmit,
  onCancel,
  onReask,
}: {
  /** The record's head while its answer is unconfirmed (#910). */
  record?: RecordHead;
  requestId: string;
  list: AskUserListSpec;
  answered?: Record<string, string>;
  notes?: Record<string, string>;
  cancelled?: boolean;
  answeredAt?: number;
  onSubmit: (requestId: string, answers: Record<string, string>, notes?: Record<string, string>) => void;
  onCancel: (requestId: string) => void;
  onReask?: (text: string) => void;
}) {
  const root = useBrainUiRoot();
  const singleKeys = useUIStore((s) => s.singleKeyShortcuts);
  // "Ask again" on a dismissed card: pending again, locally.
  const [reopened, setReopened] = useState(false);
  const base = {
    id: `asklist-${requestId}`,
    question: list.prompt,
    scale: list.scale,
    items: list.items,
    allowSkip: list.allowSkip,
    notes: list.notes,
  };

  if (answered) {
    const count = list.items.filter((i) => Object.hasOwn(answered, i.id)).length;
    return (
      <KitAskUserListCard
        {...base}
        state="answered"
        recordHead={record?.head}
        recordIcon={record?.icon}
        answers={answered}
        itemNotes={notes}
        answerMeta={listAnsweredMeta(count, list.items.length, answeredAt)}
      />
    );
  }

  if (cancelled && !reopened) {
    return (
      <KitAskUserListCard
        {...base}
        state="dismissed"
        lapsedNote={DISMISSED_NOTE}
        onAskAgain={onReask ? () => setReopened(true) : undefined}
      />
    );
  }

  return (
      <KitAskUserListCard
        // A reopened card starts clean; it is a new answer to an old question.
        key={reopened ? "reopened" : "live"}
        {...base}
        state="pending"
        prompt={`${root.config.assistantName} needs your input`}
        singleKeys={singleKeys}
        onSubmit={({ answers, notes: kept }) => {
          if (reopened) {
            // The request is gone server-side; the answer is a message now,
            // and the card closes again, or Submit would send it twice.
            onReask?.(listReaskMessage(list, answers, kept));
            setReopened(false);
            return;
          }
          // Focus moves to the answer's delivery status (#910, design §6),
          // which supersedes D37 §6's move to the composer for an answer.
          onSubmit(requestId, answers, Object.keys(kept).length ? kept : undefined);
        }}
        // A reopened card's Dismiss closes it again locally: there is no
        // server-side request left to cancel.
        onDismiss={() => (reopened ? setReopened(false) : onCancel(requestId))}
      />
  );
}
