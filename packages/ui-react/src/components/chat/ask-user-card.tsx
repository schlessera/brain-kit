import { useBrainUiRoot } from "../../root-context.js";
import { useState, useEffect, useRef, useMemo } from "react";
import {
  Check,
  X,
  MessageCircleQuestion,
  ChevronRight,
  ChevronUp,
} from "lucide-react";
import type {
  AskUserQuestion,
  AskUserOption,
  AskUserAnnotation,
} from "@schlessera/brain-ui-sdk/protocol";
import { BrainMarkdown } from "./brain-markdown.js";
import { cn } from "../../lib/utils.js";

const OTHER_LABEL = "Other";

interface PerQuestionState {
  /** Picked option labels (single-select keeps only the latest). */
  selected: string[];
  /** Free-text content when "Other" is selected. */
  otherText: string;
  /** Currently focused option index — drives the preview pane. */
  focusedIndex: number | null;
}

function defaultState(): PerQuestionState {
  return { selected: [], otherText: "", focusedIndex: null };
}

export function AskUserCard({
  requestId,
  questions,
  answered,
  cancelled,
  live = false,
  onSubmit,
  onCancel,
}: {
  requestId: string;
  questions: AskUserQuestion[];
  answered?: Record<string, string>;
  cancelled?: boolean;
  /** Parent message still streaming — keeps an expanded card open until it ends. */
  live?: boolean;
  onSubmit: (
    requestId: string,
    answers: Record<string, string>,
    annotations?: Record<string, AskUserAnnotation>
  ) => void;
  onCancel: (requestId: string) => void;
}) {
  const root = useBrainUiRoot();

  // Independent per-question state
  const [state, setState] = useState<PerQuestionState[]>(() =>
    questions.map(() => defaultState())
  );

  // Once answered/dismissed, the card rolls up to a one-line summary that
  // scrolls away with the rest of the turn. It stays open while unanswered
  // (it's an active prompt) and re-collapses when the streaming turn ends.
  const [collapsed, setCollapsed] = useState(true);
  const prevLive = useRef(live);
  useEffect(() => {
    if (prevLive.current && !live) setCollapsed(true);
    prevLive.current = live;
  }, [live]);

  // Re-initialise if the question set changes (new requestId arriving)
  const lastRequestId = useRef(requestId);
  useEffect(() => {
    if (lastRequestId.current !== requestId) {
      lastRequestId.current = requestId;
      setState(questions.map(() => defaultState()));
    }
  }, [requestId, questions]);

  // If we already have answers (from prior submit), force-fill state for display
  const lockedAnswers = answered ?? null;
  const isLocked = !!lockedAnswers || !!cancelled;

  const filledState = useMemo<PerQuestionState[]>(() => {
    if (!lockedAnswers) return state;
    return questions.map((q) => {
      const raw = lockedAnswers[q.question] ?? "";
      const labels = q.multiSelect
        ? raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : raw
          ? [raw]
          : [];
      // If the saved label isn't a known option, treat as "Other"
      const knownLabels = new Set(q.options.map((o) => o.label));
      const selected = labels.filter((l) => knownLabels.has(l));
      const otherLabels = labels.filter((l) => !knownLabels.has(l));
      const finalSelected = otherLabels.length
        ? [...selected, OTHER_LABEL]
        : selected;
      return {
        selected: finalSelected,
        otherText: otherLabels.join(", "),
        focusedIndex: null,
      };
    });
  }, [lockedAnswers, questions, state]);

  // Collapsed once locked: a compact, expandable summary that behaves like a
  // finished tool-timeline row instead of a full card pinned in place.
  if (isLocked && collapsed) {
    return (
      <AskUserSummaryRow
        questions={questions}
        answers={lockedAnswers}
        cancelled={!!cancelled}
        onExpand={() => setCollapsed(false)}
      />
    );
  }

  function toggleOption(qi: number, label: string) {
    if (isLocked) return;
    setState((prev) => {
      const next = prev.map((s, i) => {
        if (i !== qi) return s;
        const q = questions[qi];
        if (q.multiSelect) {
          const has = s.selected.includes(label);
          return {
            ...s,
            selected: has
              ? s.selected.filter((l) => l !== label)
              : [...s.selected, label],
          };
        }
        return {
          ...s,
          selected: s.selected[0] === label ? [] : [label],
        };
      });
      return next;
    });
  }

  function setFocus(qi: number, idx: number | null) {
    if (isLocked) return;
    setState((prev) =>
      prev.map((s, i) => (i === qi ? { ...s, focusedIndex: idx } : s))
    );
  }

  function setOtherText(qi: number, text: string) {
    if (isLocked) return;
    setState((prev) =>
      prev.map((s, i) => (i === qi ? { ...s, otherText: text } : s))
    );
  }

  const canSubmit = !isLocked && questions.every((_q, i) => {
    const s = state[i];
    if (s.selected.length === 0) return false;
    if (s.selected.includes(OTHER_LABEL) && !s.otherText.trim()) return false;
    return true;
  });

  function handleSubmit() {
    if (!canSubmit) return;
    const answers: Record<string, string> = {};
    const annotations: Record<string, AskUserAnnotation> = {};
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const s = state[i];
      const labels: string[] = [];
      let usedOther = false;
      for (const sel of s.selected) {
        if (sel === OTHER_LABEL) {
          if (s.otherText.trim()) labels.push(s.otherText.trim());
          usedOther = true;
        } else {
          labels.push(sel);
        }
      }
      answers[q.question] = q.multiSelect ? labels.join(", ") : (labels[0] ?? "");

      // Capture preview from a single non-other selection for annotations
      if (!usedOther && !q.multiSelect && s.selected.length === 1) {
        const picked = q.options.find((o) => o.label === s.selected[0]);
        if (picked?.preview) {
          annotations[q.question] = { preview: picked.preview };
        }
      }
    }
    onSubmit(
      requestId,
      answers,
      Object.keys(annotations).length ? annotations : undefined
    );
  }

  function handleCancel() {
    onCancel(requestId);
  }

  return (
    <div className="rounded-xl border border-accent/30 bg-surface px-4 py-4 shadow-[0_0_0_1px_rgba(91,181,162,0.08)]">
      <div className="mb-3 flex items-center gap-2 text-xs uppercase tracking-wider text-accent/80">
        <MessageCircleQuestion className="h-3.5 w-3.5" />
        <span className="font-[family-name:var(--font-mono)]">
          {isLocked
            ? cancelled
              ? "Dismissed"
              : "You answered"
            : `${root.config.assistantName} needs your input`}
        </span>
        {isLocked && (
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className="ml-auto flex items-center gap-1 text-[11px] normal-case tracking-normal text-muted-foreground/50 transition-colors hover:text-muted-foreground"
          >
            <ChevronUp className="h-3 w-3" />
            Collapse
          </button>
        )}
      </div>

      <div className="space-y-5">
        {questions.map((q, qi) => (
          <QuestionBlock
            key={qi}
            question={q}
            state={filledState[qi]}
            locked={isLocked}
            onToggleOption={(label) => toggleOption(qi, label)}
            onFocus={(idx) => setFocus(qi, idx)}
            onOtherChange={(t) => setOtherText(qi, t)}
          />
        ))}
      </div>

      {!isLocked && (
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={handleCancel}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
            Dismiss
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-xs font-medium transition-all",
              canSubmit
                ? "bg-accent text-accent-foreground hover:brightness-110"
                : "bg-surface-raised text-muted-foreground/40 cursor-not-allowed"
            )}
          >
            <Check className="h-3.5 w-3.5" />
            Submit
          </button>
        </div>
      )}
    </div>
  );
}

/** One-line, expandable stand-in for an answered/dismissed question. */
function AskUserSummaryRow({
  questions,
  answers,
  cancelled,
  onExpand,
}: {
  questions: AskUserQuestion[];
  answers: Record<string, string> | null;
  cancelled: boolean;
  onExpand: () => void;
}) {
  const detail = cancelled
    ? "Dismissed"
    : questions
        .map((q) => {
          const a = answers?.[q.question];
          return a ? `${q.header}: ${a}` : q.header;
        })
        .join(" · ");
  return (
    <button
      type="button"
      onClick={onExpand}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground/70 transition-colors hover:text-foreground"
    >
      <MessageCircleQuestion className="h-3.5 w-3.5 shrink-0 text-accent/70" />
      <span className="min-w-0 truncate font-[family-name:var(--font-mono)]">
        {!cancelled && <span className="text-accent/70">Answered · </span>}
        {detail}
      </span>
      <ChevronRight className="h-3 w-3 shrink-0" />
    </button>
  );
}

function QuestionBlock({
  question,
  state,
  locked,
  onToggleOption,
  onFocus,
  onOtherChange,
}: {
  question: AskUserQuestion;
  state: PerQuestionState;
  locked: boolean;
  onToggleOption: (label: string) => void;
  onFocus: (idx: number | null) => void;
  onOtherChange: (text: string) => void;
}) {
  const optionsWithOther: Array<AskUserOption & { isOther?: boolean }> = [
    ...question.options,
    { label: OTHER_LABEL, description: "Provide a custom answer.", isOther: true },
  ];

  const focusedOption =
    state.focusedIndex !== null ? optionsWithOther[state.focusedIndex] : null;
  const previewToShow =
    focusedOption?.preview ??
    (state.selected.length === 1 && !state.selected.includes(OTHER_LABEL)
      ? question.options.find((o) => o.label === state.selected[0])?.preview
      : undefined);

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded-md border border-accent/30 bg-accent/10 px-2 py-0.5 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-accent">
          {question.header}
        </span>
        {question.multiSelect && (
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60">
            multi-select
          </span>
        )}
      </div>
      <div className="mb-3 text-sm leading-relaxed text-foreground">
        {question.question}
      </div>

      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <ul className="space-y-1.5">
          {optionsWithOther.map((opt, idx) => {
            const selected = state.selected.includes(opt.label);
            return (
              <li key={opt.label}>
                <button
                  type="button"
                  onClick={() => onToggleOption(opt.label)}
                  onMouseEnter={() => onFocus(idx)}
                  onFocus={() => onFocus(idx)}
                  disabled={locked}
                  className={cn(
                    "group flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors",
                    selected
                      ? "border-accent/60 bg-accent/10"
                      : "border-border bg-background hover:bg-surface-raised",
                    locked && "cursor-default opacity-90"
                  )}
                >
                  <span
                    className={cn(
                      "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                      question.multiSelect ? "rounded-sm" : "rounded-full",
                      selected
                        ? "border-accent bg-accent text-accent-foreground"
                        : "border-border bg-background"
                    )}
                  >
                    {selected && <Check className="h-3 w-3" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block text-sm font-medium",
                        opt.isOther
                          ? "italic text-muted-foreground group-hover:text-foreground"
                          : "text-foreground"
                      )}
                    >
                      {opt.label}
                    </span>
                    {opt.description && (
                      <span className="block text-xs leading-snug text-muted-foreground">
                        {opt.description}
                      </span>
                    )}
                  </span>
                </button>
                {opt.isOther && state.selected.includes(OTHER_LABEL) && (
                  <textarea
                    value={state.otherText}
                    onChange={(e) => onOtherChange(e.target.value)}
                    disabled={locked}
                    placeholder="Type your answer..."
                    rows={2}
                    className="mt-1.5 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/40 focus:border-accent/60 focus:outline-none"
                  />
                )}
              </li>
            );
          })}
        </ul>

        {previewToShow && (
          <div className="hidden min-w-0 md:block">
            <div className="rounded-lg border border-border bg-background p-3">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60 font-[family-name:var(--font-mono)]">
                Preview
              </div>
              <BrainMarkdown
                content={previewToShow}
                className="brain-prose text-xs"
              />
            </div>
          </div>
        )}
      </div>

      {/* Mobile preview drops below the options when a preview exists */}
      {previewToShow && (
        <div className="mt-2 md:hidden">
          <details className="rounded-lg border border-border bg-background">
            <summary className="cursor-pointer px-3 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">
              Preview
            </summary>
            <div className="border-t border-border px-3 py-2">
              <BrainMarkdown
                content={previewToShow}
                className="brain-prose text-xs"
              />
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
