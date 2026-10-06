import { useState } from "react";
import { AskUserFormCard } from "@schlessera/brain-ui-kit";
import type {
  AskUserFormSpec,
  AskUserFormAnswers,
} from "@schlessera/brain-ui-sdk/protocol";
import { askUserFormPayload } from "@schlessera/brain-ui-sdk/internal/client";
import { useBrainUiRoot } from "../../root-context.js";
import { useUIStore } from "../../stores/ui-store.js";
import { formatRelativeTime } from "../../lib/format-time.js";
import { DISMISSED_NOTE } from "./ask-user-card.js";
import { formReaskMessage } from "./reask-text.js";
import type { RecordHead } from "./answer-text.js";

export function AskUserFormExchangeCard(p: {
  /** The record's head while its answer is unconfirmed (#910). */
  record?: RecordHead;
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
        recordHead={p.record?.head}
        recordIcon={p.record?.icon}
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
        if (reopened) {
          // A reask is a new message: the reader continues in the composer.
          document.querySelector<HTMLElement>("textarea[data-composer]")?.focus();
          p.onReask?.(formReaskMessage(p.form, result));
          setReopened(false);
          // An answer: focus moves to its delivery status (#910, design §6).
        } else p.onSubmit?.(p.requestId, result.answers, result.visibleNodes);
      }}
      onDismiss={() =>
        reopened ? setReopened(false) : p.onCancel(p.requestId)
      }
    />
  );
}
