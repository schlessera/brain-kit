/**
 * The `ask_user` exchange, one kit `AskUserCard` per question (D38 §1).
 *
 * An exchange is not a tool card. It has three states and all three stay in
 * the transcript at full contrast — nothing rolls up or fades, because a
 * question the agent asked is part of the record whichever way it was
 * answered:
 *
 *   `pending`  — the options, one focus stop, Submit / Dismiss. "Other"
 *                opens the kit's free-text field in place of the Submit row:
 *                a typed alternative is the same exchange, not a new one.
 *   `answered` — the chosen answer in mono teal, with when. The alternatives
 *                are GONE, not dimmed: they were never the record.
 *   `typed`    — the user answered in the composer instead. The card quotes
 *                what it took, under a neutral border.
 *
 * A dismissed question is a fourth fact the kit has no state for yet: it
 * renders as the pending head with no options, no actions and a neutral note.
 *
 * The exchange's answers are keyed by question text and submitted together,
 * so the action row sits on the LAST question's card and gathers every
 * question's selection. Multi-select questions keep the app's own checkbox
 * rows: the kit's `ChoiceOption` is a radio, and a radio that stays checked
 * beside another checked radio is a lie to assistive tech.
 */

import { useBrainUiRoot } from "../../root-context.js";
import { useEffect, useRef, useState } from "react";
import {
  AskUserCard as KitAskUserCard,
  Button,
  Callout,
  Chip,
  Surface,
  type AskUserOption as KitAskUserOption,
} from "@schlessera/brain-ui-kit";
import type {
  AskUserQuestion,
  AskUserAnnotation,
} from "@schlessera/brain-ui-sdk/protocol";
import { BrainMarkdown } from "./brain-markdown.js";
import { formatRelativeTime } from "../../lib/format-time.js";

const OTHER_LABEL = "Other";

interface PerQuestionState {
  /** Picked option labels (single-select keeps only the latest). */
  selected: string[];
  /** The kit's free-text field is open in place of the Submit row. */
  otherOpen: boolean;
  /** A free-text answer already taken from the field (multi-question only). */
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

/** "you chose this · 3m ago", or just "you chose this" when no time is known. */
export function answeredMeta(answeredAt: number | undefined): string {
  return answeredAt === undefined
    ? "you chose this"
    : `you chose this · ${formatRelativeTime(answeredAt)}`;
}

export const TYPED_META = "taken from your next message";

/** The typed answer is the user's own words, so the card quotes them. */
export function quoted(text: string): string {
  return text ? `\u201C${text}\u201D` : "";
}
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
}) {
  const root = useBrainUiRoot();
  const prompt = `${root.config.assistantName} needs your input`;

  const [state, setState] = useState<PerQuestionState[]>(() =>
    questions.map(() => defaultState())
  );

  // Re-initialise if the question set changes (new requestId arriving).
  const lastRequestId = useRef(requestId);
  useEffect(() => {
    if (lastRequestId.current !== requestId) {
      lastRequestId.current = requestId;
      setState(questions.map(() => defaultState()));
    }
  }, [requestId, questions]);

  const isLocked = !!answered || !!cancelled;

  function pick(qi: number, label: string) {
    if (isLocked) return;
    setState((prev) =>
      prev.map((s, i) => {
        if (i !== qi) return s;
        const q = questions[qi];
        if (label === OTHER_LABEL) {
          // Multi-select: Other is one checkbox among the others and toggles
          // off again; single-select: it is the pick, and opens the field.
          return q.multiSelect
            ? { ...s, selected: toggled(s.selected, OTHER_LABEL) }
            : { ...s, otherOpen: true, selected: [OTHER_LABEL] };
        }
        return {
          ...s,
          otherOpen: false,
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

  function answerFor(qi: number, s: PerQuestionState): string[] {
    return s.selected.flatMap((label) =>
      label === OTHER_LABEL ? (s.otherText.trim() ? [s.otherText.trim()] : []) : [label]
    );
  }

  const complete = questions.every((_q, i) => answerFor(i, state[i]).length > 0);

  function submit(override?: { qi: number; text: string }) {
    const answers: Record<string, string> = {};
    const annotations: Record<string, AskUserAnnotation> = {};
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const s =
        override && override.qi === i
          ? { ...state[i], selected: [OTHER_LABEL], otherText: override.text }
          : state[i];
      const labels = answerFor(i, s);
      if (labels.length === 0) return;
      answers[q.question] = q.multiSelect ? labels.join(", ") : labels[0];

      // A single chosen option with a preview travels as an annotation, so
      // the agent sees what the user saw.
      if (!q.multiSelect && s.selected.length === 1 && s.selected[0] !== OTHER_LABEL) {
        const picked = q.options.find((o) => o.label === s.selected[0]);
        if (picked?.preview) annotations[q.question] = { preview: picked.preview };
      }
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
          const answer = recordedAnswer(q, answered);
          return (
            <KitAskUserCard
              key={id}
              id={id}
              state={typed ? "typed" : "answered"}
              tag={q.header}
              question={q.question}
              options={[]}
              showActions={false}
              // The kit prints the answer as given; a typed one is a quote.
              answer={typed ? quoted(answer) : answer}
              answerMeta={typed ? TYPED_META : answeredMeta(answeredAt)}
            />
          );
        }

        if (cancelled) {
          // The kit has no `dismissed` state (reported as a gap): the pending
          // head with the options gone, and the fact as a neutral note.
          return (
            <div key={id} className="space-y-2">
              <KitAskUserCard
                id={id}
                state="pending"
                tone="teal"
                prompt="Question dismissed"
                tag={q.header}
                question={q.question}
                options={[]}
                showActions={false}
              />
              <Callout tone="neutral" variant="boxed" mono text={DISMISSED_NOTE} />
            </div>
          );
        }

        const s = state[qi];
        const preview = previewFor(q, s);

        if (q.multiSelect) {
          return (
            <MultiSelectQuestion
              key={id}
              id={id}
              prompt={prompt}
              question={q}
              selected={s.selected}
              otherText={s.otherText}
              preview={preview}
              onToggle={(label) => pick(qi, label)}
              onFocusOption={(label) => focus(qi, label)}
              onOtherChange={(text) =>
                setState((prev) =>
                  prev.map((st, i) => (i === qi ? { ...st, otherText: text } : st))
                )
              }
              showActions={isLast}
              canSubmit={complete}
              onSubmit={() => submit()}
              onCancel={() => onCancel(requestId)}
            />
          );
        }

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
              onSecondary={() => onCancel(requestId)}
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

/**
 * A multi-select question. The kit's `ChoiceOption` is a radio, so the rows
 * here are real checkboxes inside a kit `Surface` carrying the same head; the
 * actions are kit buttons. Reported as a kit gap.
 */
function MultiSelectQuestion({
  id,
  prompt,
  question,
  selected,
  otherText,
  preview,
  onToggle,
  onFocusOption,
  onOtherChange,
  showActions,
  canSubmit,
  onSubmit,
  onCancel,
}: {
  id: string;
  prompt: string;
  question: AskUserQuestion;
  selected: string[];
  otherText: string;
  preview?: string;
  onToggle: (label: string) => void;
  onFocusOption: (label: string | null) => void;
  onOtherChange: (text: string) => void;
  showActions: boolean;
  canSubmit: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const otherOn = selected.includes(OTHER_LABEL);
  const rows = [
    ...question.options.map((o) => ({ label: o.label, description: o.description })),
    { label: OTHER_LABEL, description: "Provide a custom answer." },
  ];
  return (
    <Surface tone="teal" label={prompt} labelIcon="ask" pad={13} radius={14}>
      <div className="mb-2 flex items-center gap-2">
        <Chip label={question.header} tone="teal" variant="soft" caps />
        <Chip label="pick any" tone="neutral" variant="soft" caps />
      </div>
      <div id={`${id}-question`} className="mb-2.5 text-[13px] leading-[1.55] text-foreground">
        {question.question}
      </div>
      <div role="group" aria-labelledby={`${id}-question`} className="space-y-1.5">
        {rows.map((row) => {
          const on = selected.includes(row.label);
          return (
            <label
              key={row.label}
              className="flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-background px-3 py-2"
            >
              <input
                type="checkbox"
                checked={on}
                onChange={() => onToggle(row.label)}
                onFocus={() => onFocusOption(row.label === OTHER_LABEL ? null : row.label)}
                className="mt-0.5 h-4 w-4 accent-accent"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">{row.label}</span>
                {row.description ? (
                  <span className="block text-xs leading-snug text-muted-foreground">
                    {row.description}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
      {preview ? (
        <div className="mt-2">
          <PreviewPane content={preview} />
        </div>
      ) : null}
      {otherOn ? (
        <textarea
          value={otherText}
          onChange={(e) => onOtherChange(e.target.value)}
          placeholder="Type your answer…"
          rows={2}
          aria-label="Other answer"
          className="mt-2 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/40 focus:border-accent/60 focus:outline-none"
        />
      ) : null}
      {showActions ? (
        <div className="mt-3 flex justify-end gap-2">
          <Button label="Dismiss" tone="quiet" size="sm" block={false} onClick={onCancel} />
          <Button
            label="Submit"
            tone="affirm"
            size="sm"
            block={false}
            disabled={!canSubmit}
            onClick={onSubmit}
          />
        </div>
      ) : null}
    </Surface>
  );
}
