import { useState } from "react";
import { AskUserFormCard } from "@schlessera/brain-ui-kit";
import type {
  AskUserFormSpec,
  AskUserFormAnswers,
} from "@schlessera/brain-ui-sdk/protocol";
import { askUserFormPayload } from "@schlessera/brain-ui-sdk/tool-contracts";
import { useBrainUiRoot } from "../../root-context.js";
import { useUIStore } from "../../stores/ui-store.js";
import { formatRelativeTime } from "../../lib/format-time.js";
import { DISMISSED_NOTE } from "./ask-user-card.js";

export function AskUserFormExchangeCard(p: {
  requestId: string;
  form: AskUserFormSpec;
  answers?: AskUserFormAnswers;
  cancelled?: boolean;
  answeredAt?: number;
  onSubmit?: (
    requestId: string,
    answers: AskUserFormAnswers,
    visibleNodes: string[],
  ) => void;
  onCancel: (requestId: string) => void;
  onReask?: (text: string) => void;
}) {
  const root = useBrainUiRoot();
  const singleKeys = useUIStore((state) => state.singleKeyShortcuts);
  const [reopened, setReopened] = useState(false);
  const base = {
    id: `askform-${p.requestId}`,
    question: p.form.prompt,
    nodes: p.form.nodes,
  };
  if (p.answers)
    return (
      <AskUserFormCard
        {...base}
        state="answered"
        answers={p.answers}
        answerMeta={`you answered${p.answeredAt === undefined ? "" : ` · ${formatRelativeTime(p.answeredAt)}`}`}
      />
    );
  if (p.cancelled && !reopened)
    return (
      <AskUserFormCard
        {...base}
        state="dismissed"
        lapsedNote={DISMISSED_NOTE}
        onAskAgain={p.onReask ? () => setReopened(true) : undefined}
      />
    );
  return (
    <AskUserFormCard
      {...base}
      key={reopened ? "reopened" : "live"}
      singleKeys={singleKeys}
      prompt={`${root.config.assistantName} needs your input`}
      onSubmit={(submitted) => {
        const result = askUserFormPayload(p.form, submitted);
        document.querySelector<HTMLElement>("textarea[data-composer]")?.focus();
        if (reopened) {
          p.onReask?.(
            `Answering “${p.form.prompt}”: ${JSON.stringify(result)}`,
          );
          setReopened(false);
        } else p.onSubmit?.(p.requestId, result.answers, result.visibleNodes);
      }}
      onDismiss={() =>
        reopened ? setReopened(false) : p.onCancel(p.requestId)
      }
    />
  );
}
