import { useState } from "react";
import { AskUserRankCard } from "@schlessera/brain-ui-kit";
import type { AskUserRankSpec } from "@schlessera/brain-ui-sdk/protocol";
import { useBrainUiRoot } from "../../root-context.js";
import { useUIStore } from "../../stores/ui-store.js";
import { formatRelativeTime } from "../../lib/format-time.js";
import { DISMISSED_NOTE } from "./ask-user-card.js";
import { rankReaskMessage } from "./reask-text.js";
import type { RecordHead } from "./answer-text.js";

/** Composer sends remain ordinary text; only the card records an id order. */
export function AskUserRankExchangeCard(p: {
  /** The record's head while its answer is unconfirmed (#910). */
  record?: RecordHead;
  requestId: string;
  rank: AskUserRankSpec;
  order?: string[];
  unchanged?: boolean;
  cancelled?: boolean;
  answeredAt?: number;
  onSubmit?: (requestId: string, order: string[], unchanged: boolean) => void;
  onCancel: (requestId: string) => void;
  onReask?: (text: string) => void;
}) {
  const root = useBrainUiRoot();
  const singleKeys = useUIStore((state) => state.singleKeyShortcuts);
  const [reopened, setReopened] = useState(false);
  const base = { id: `askrank-${p.requestId}`, question: p.rank.prompt, items: p.rank.items, cutoff: p.rank.cutoff };
  if (p.order) return <AskUserRankCard {...base} state="answered" recordHead={p.record?.head} recordIcon={p.record?.icon} order={p.order} unchanged={p.unchanged}
    answerMeta={`you ${p.unchanged ? "kept this order" : `ranked ${p.rank.cutoff ?? p.order.length}`}${p.answeredAt === undefined ? "" : ` · ${formatRelativeTime(p.answeredAt)}`}`} />;
  if (p.cancelled && !reopened) return <AskUserRankCard {...base} state="dismissed" lapsedNote={DISMISSED_NOTE} onAskAgain={p.onReask ? () => setReopened(true) : undefined} />;
  return <AskUserRankCard {...base} key={reopened ? "reopened" : "live"} singleKeys={singleKeys} prompt={`${root.config.assistantName} needs your input`}
    onSubmit={({ order, unchanged }) => {
      if (reopened) {
        // A reask is a new message: the reader continues in the composer.
        document.querySelector<HTMLElement>("textarea[data-composer]")?.focus();
        p.onReask?.(rankReaskMessage(p.rank, order));
        setReopened(false);
        // An answer: focus moves to its delivery status (#910, design §6).
      } else p.onSubmit?.(p.requestId, order, unchanged);
    }} onDismiss={() => reopened ? setReopened(false) : p.onCancel(p.requestId)} />;
}
