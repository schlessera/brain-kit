import { useState } from "react";
import { AskUserRankCard } from "@schlessera/brain-ui-kit";
import type { AskUserRankSpec } from "@schlessera/brain-ui-sdk/protocol";
import { useBrainUiRoot } from "../../root-context.js";
import { useUIStore } from "../../stores/ui-store.js";
import { formatRelativeTime } from "../../lib/format-time.js";
import { DISMISSED_NOTE } from "./ask-user-card.js";

/** Composer sends remain ordinary text; only the card records an id order. */
export function AskUserRankExchangeCard(p: {
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
  if (p.order) return <AskUserRankCard {...base} state="answered" order={p.order} unchanged={p.unchanged}
    answerMeta={`you ${p.unchanged ? "kept this order" : `ranked ${p.rank.cutoff ?? p.order.length}`}${p.answeredAt === undefined ? "" : ` · ${formatRelativeTime(p.answeredAt)}`}`} />;
  if (p.cancelled && !reopened) return <AskUserRankCard {...base} state="dismissed" lapsedNote={DISMISSED_NOTE} onAskAgain={p.onReask ? () => setReopened(true) : undefined} />;
  return <AskUserRankCard {...base} key={reopened ? "reopened" : "live"} singleKeys={singleKeys} prompt={`${root.config.assistantName} needs your input`}
    onSubmit={({ order, unchanged }) => {
      document.querySelector<HTMLElement>("textarea[data-composer]")?.focus();
      if (reopened) {
        const labels = new Map(p.rank.items.map((item) => [item.id, item.label]));
        p.onReask?.([`Answering “${p.rank.prompt}”:`, ...order.map((id, index) => `${index + 1}. ${labels.get(id)}`), ...(p.rank.cutoff ? [`Only the top ${p.rank.cutoff} matter.`] : [])].join("\n"));
        setReopened(false);
      } else p.onSubmit?.(p.requestId, order, unchanged);
    }} onDismiss={() => reopened ? setReopened(false) : p.onCancel(p.requestId)} />;
}
