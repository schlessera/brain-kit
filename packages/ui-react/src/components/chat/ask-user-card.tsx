/**
 * The `ask_user` exchange, one kit `AskUserCard` per question (D38 §1).
 *
 * An exchange is not a tool card. It has four states and all four stay in
 * the transcript at full contrast — nothing rolls up or fades, because a
 * question the agent asked is part of the record whichever way it was
 * answered:
 *
 *   `pending`   — the options, one focus stop, Submit / Dismiss. "Other"
 *                 opens the kit's free-text field in place of the Submit row:
 *                 a typed alternative is the same exchange, not a new one.
 *   `answered`  — the chosen answer in mono teal, with when. The alternatives
 *                 are GONE, not dimmed: they were never the record. A
 *                 multi-select lists every choice as its own row.
 *   `typed`     — the user answered in the composer instead. The card quotes
 *                 what it took, under a neutral border.
 *   `dismissed` — the question the turn outlived, in gold (seventh drop,
 *                 ruling 7): no options, a lapsed row stating the fact, and
 *                 "Ask again". The server-side request is already resolved,
 *                 so asking again reopens the card LOCALLY to pending, and a
 *                 submit from a reopened card goes out as a normal composer
 *                 message quoting the question and the chosen answer(s)
 *                 (`onReask`) rather than as an `ask_user_response` nobody is
 *                 waiting for. No `onReask`, no button (D20).
 *
 * Multi-select questions ride the same kit card with `multi` (ruling 6): the
 * options are `ChoiceOption multiple` — checkbox role, square mark — inside a
 * `role="group"`, and "Other" toggles like any other row. The exchange's
 * answers are keyed by question text and submitted together, so the action
 * row sits on the LAST question's card and gathers every question's
 * selection.
 */

import { useBrainUiRoot } from "../../root-context.js";
import { useEffect, useRef, useState } from "react";
import {
  AskUserCard as KitAskUserCard,
  Surface,
  type AskUserOption as KitAskUserOption,
} from "@schlessera/brain-ui-kit";
import type {
  AskUserQuestion,
  AskUserAnnotation,
} from "@schlessera/brain-ui-sdk/protocol";
import { BrainMarkdown } from "./brain-markdown.js";
import { formatRelativeTime } from "../../lib/format-time.js";
import { reaskMessage } from "./ask-user-typed.js";

const OTHER_LABEL = "Other";

/** A multi-select's picks travel as one string; this is the seam. */
const MULTI_JOIN = ", ";

interface PerQuestionState {
  /** Picked option labels (single-select keeps only the latest). */
  selected: string[];
  /** The kit's free-text field is open in place of the Submit row. */
  otherOpen: boolean;
  /** A free-text answer already taken from the field (held until Submit). */
  otherText: string;
  /** The option holding focus — the contract's `preview` follows focus, so
   * ↑↓ over the options shows each one's preview before anything is picked. */
  focused: string | null;
}

function defaultState(): PerQuestionState {
  return { selected: [], otherOpen: false, otherText: "", focused: null };
}

/** The preview to show for a question: the focused option's, else the single
 * chosen one's. `preview` is "content rendered when an option is focused"
 * in the ask_user contract; selection is the fallback once focus has moved on. */
export function previewFor(
  question: AskUserQuestion,
  state: Pick<PerQuestionState, "focused" | "selected">
): string | undefined {
  const focused = state.focused ? question.options.find((o) => o.label === state.focused) : undefined;
  if (focused?.preview) return focused.preview;
  if (state.selected.length === 1 && state.selected[0] !== OTHER_LABEL) {
    return question.options.find((o) => o.label === state.selected[0])?.preview;
  }
  return undefined;
}

/** The answer the exchange recorded for one question, as the card shows it. */
export function recordedAnswer(
  question: AskUserQuestion,
  answers: Record<string, string> | undefined
): string {
  return answers?.[question.question] ?? "";
}

/**
 * The recorded answer as the rows the card lists: one for a single-select,
 * one per pick for a multi-select. The picks were joined by this module, so
 * splitting on the same seam is the inverse of its own encoding — a label
 * that itself contains ", " is the one case it cannot tell apart.
 */
export function recordedAnswers(
  question: AskUserQuestion,
  answers: Record<string, string> | undefined
): string[] {
  const answer = recordedAnswer(question, answers);
  if (!question.multiSelect) return [answer];
  return answer.split(MULTI_JOIN).filter((a) => a.length > 0);
}

/** "you chose this · 3m ago", "you chose 2 · 3m ago", or without the time
 * when none is known. */
export function answeredMeta(answeredAt: number | undefined, count = 1): string {
  const chose = count > 1 ? `you chose ${count}` : "you chose this";
  return answeredAt === undefined ? chose : `${chose} · ${formatRelativeTime(answeredAt)}`;
}

export const TYPED_META = "taken from your next message";

/** The typed answer is the user's own words, so the card quotes them. */
export function quoted(text: string): string {
  return text ? `\u201C${text}\u201D` : "";
}

/** The lapsed row on a dismissed card: what happened, in the app's terms. */
export const DISMISSED_NOTE = "dismissed · the agent got no answer";

export function AskUserCard({
  requestId,
  questions,
  answered,
  cancelled,
  typed,
  answeredAt,
  onSubmit,
  onCancel,
  onReask,
}: {
  requestId: string;
  questions: AskUserQuestion[];
  answered?: Record<string, string>;
  cancelled?: boolean;
  /** The answer was typed into the composer rather than chosen. */
  typed?: boolean;
  /** When the answer was given; absent on resumed history. */
  answeredAt?: number;
  onSubmit: (
    requestId: string,
    answers: Record<string, string>,
    annotations?: Record<string, AskUserAnnotation>
  ) => void;
  onCancel: (requestId: string) => void;
  /**
   * A dismissed question asked again: the answer goes out as a normal
   * composer message, because the server already resolved the request.
   * Absent, the dismissed card offers no "Ask again".
   */
  onReask?: (text: string) => void;
}) {
  const root = useBrainUiRoot();
  const prompt = `${root.config.assistantName} needs your input`;

  const [state, setState] = useState<PerQuestionState[]>(() =>
    questions.map(() => defaultState())
  );
  // "Ask again" on a dismissed card: pending again, locally.
  const [reopened, setReopened] = useState(false);

  // Re-initialise if the question set changes (new requestId arriving).
  const lastRequestId = useRef(requestId);
  useEffect(() => {
    if (lastRequestId.current !== requestId) {
      lastRequestId.current = requestId;
      setState(questions.map(() => defaultState()));
      setReopened(false);
    }
  }, [requestId, questions]);

  const dismissed = !!cancelled && !answered && !reopened;
  const isLocked = !!answered || dismissed;

  function pick(qi: number, label: string) {
    if (isLocked) return;
    setState((prev) =>
      prev.map((s, i) => {
        if (i !== qi) return s;
        const q = questions[qi];
        if (label === OTHER_LABEL) {
          // Multi-select: Other toggles like any other row, and opens the
          // field while it is on; single-select: it is the pick.
          if (q.multiSelect) {
            const on = !s.selected.includes(OTHER_LABEL);
            return { ...s, selected: toggled(s.selected, OTHER_LABEL), otherOpen: on };
          }
          return { ...s, otherOpen: true, selected: [OTHER_LABEL] };
        }
        // Multi-select: Other stays open while it is on — picking another
        // row beside it must not close the field and strand an empty custom
        // answer. Single-select: any other pick replaces Other.
        return {
          ...s,
          otherOpen: q.multiSelect ? s.selected.includes(OTHER_LABEL) : false,
          selected: q.multiSelect
            ? toggled(s.selected, label)
            : s.selected[0] === label
              ? []
              : [label],
        };
      })
    );
  }

  function focus(qi: number, label: string | null) {
    setState((prev) => prev.map((s, i) => (i === qi ? { ...s, focused: label } : s)));
  }

  function answerFor(s: PerQuestionState): string[] {
    return s.selected.flatMap((label) =>
      label === OTHER_LABEL ? (s.otherText.trim() ? [s.otherText.trim()] : []) : [label]
    );
  }

  const complete = questions.every((_q, i) => answerFor(state[i]).length > 0);

  function submit(override?: { qi: number; text: string }) {
    const answers: Record<string, string> = {};
    const annotations: Record<string, AskUserAnnotation> = {};
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const s =
        override && override.qi === i
          ? {
              ...state[i],
              // A multi-select keeps its other picks beside the typed one.
              selected: q.multiSelect
                ? state[i].selected.includes(OTHER_LABEL)
                  ? state[i].selected
                  : [...state[i].selected, OTHER_LABEL]
                : [OTHER_LABEL],
              otherText: override.text,
            }
          : state[i];
      const labels = answerFor(s);
      if (labels.length === 0) return;
      answers[q.question] = q.multiSelect ? labels.join(MULTI_JOIN) : labels[0];

      // A single chosen option with a preview travels as an annotation, so
      // the agent sees what the user saw.
      if (!q.multiSelect && s.selected.length === 1 && s.selected[0] !== OTHER_LABEL) {
        const picked = q.options.find((o) => o.label === s.selected[0]);
        if (picked?.preview) annotations[q.question] = { preview: picked.preview };
      }
    }
    if (reopened) {
      // The request is gone server-side; the answer is a message now — and
      // the card closes again, or Submit would send it twice.
      onReask?.(reaskMessage(questions, answers));
      setReopened(false);
      return;
    }
    onSubmit(
      requestId,
      answers,
      Object.keys(annotations).length ? annotations : undefined
    );
  }

  /**
   * The kit's Other field submitted. With one question that IS the answer;
   * with several, the text is held for that question and the last card's
   * Submit sends everything together.
   */
  function takeOther(qi: number, text: string) {
    const trimmed = text.trim();
    if (!trimmed || isLocked) return;
    if (questions.length === 1) {
      submit({ qi, text: trimmed });
      return;
    }
    setState((prev) =>
      prev.map((s, i) => (i === qi ? { ...s, otherOpen: false, otherText: trimmed } : s))
    );
  }

  return (
    <div className="space-y-3">
      {questions.map((q, qi) => {
        const isLast = qi === questions.length - 1;
        const id = `${requestId}-${qi}`;

        if (answered) {
          const answers = recordedAnswers(q, answered);
          return (
            <KitAskUserCard
              key={id}
              id={id}
              state={typed ? "typed" : "answered"}
              multi={q.multiSelect}
              tag={q.header}
              question={q.question}
              options={[]}
              showActions={false}
              // The kit prints the answers as given; a typed one is a quote.
              answers={typed ? [quoted(recordedAnswer(q, answered))] : answers}
              answerMeta={typed ? TYPED_META : answeredMeta(answeredAt, answers.length)}
            />
          );
        }

        if (dismissed) {
          return (
            <KitAskUserCard
              key={id}
              id={id}
              state="dismissed"
              multi={q.multiSelect}
              tag={q.header}
              question={q.question}
              options={[]}
              showActions={false}
              lapsedNote={DISMISSED_NOTE}
              // One "Ask again" per exchange, on the last card, like Submit.
              onAskAgain={onReask && isLast ? () => setReopened(true) : undefined}
            />
          );
        }

        const s = state[qi];
        const preview = previewFor(q, s);

        const options: KitAskUserOption[] = [
          ...q.options.map((o) => ({
            title: o.label,
            subtitle: o.description,
            selected: s.selected.includes(o.label),
            onClick: () => pick(qi, o.label),
            onFocus: () => focus(qi, o.label),
          })),
          {
            title: OTHER_LABEL,
            subtitle: s.otherText || "Provide a custom answer.",
            italic: !s.otherText,
            dim: !s.otherText,
            selected: s.selected.includes(OTHER_LABEL),
            onClick: () => pick(qi, OTHER_LABEL),
            onFocus: () => focus(qi, null),
          },
        ];

        return (
          <div key={id} className="space-y-2">
            <KitAskUserCard
              id={id}
              state="pending"
              multi={q.multiSelect}
              prompt={prompt}
              tag={q.header}
              question={q.question}
              options={options}
              otherOpen={s.otherOpen}
              otherPlaceholder="Type your answer…"
              onOtherSubmit={(text) => takeOther(qi, text)}
              showActions={isLast}
              // The kit's action row cannot be disabled from here; an
              // incomplete Submit is a no-op rather than a partial answer.
              onPrimary={() => (complete ? submit() : undefined)}
              // A reopened card's Dismiss closes it again locally: there is
              // no server-side request left to cancel.
              onSecondary={() => (reopened ? setReopened(false) : onCancel(requestId))}
            />
            {preview ? <PreviewPane content={preview} /> : null}
          </div>
        );
      })}
    </div>
  );
}

function toggled(list: string[], label: string): string[] {
  return list.includes(label) ? list.filter((l) => l !== label) : [...list, label];
}

/** The focused (else chosen) option's preview, under the question it belongs to. */
function PreviewPane({ content }: { content: string }) {
  return (
    <Surface label="Preview" labelIcon="file" pad={10}>
      <BrainMarkdown content={content} className="brain-prose text-xs" />
    </Surface>
  );
}
