import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useRoving } from "../internal/roving.js";
import { AskOtherField } from "../internal/AskOtherField.js";
import { Button } from "../primitives/Button.js";
import { Chip } from "../primitives/Chip.js";
import { Icon } from "../primitives/Icon.js";
import { ChoiceOption } from "../rows/ChoiceOption.js";
import { accent, color, font, token } from "../tokens.js";
import type { AskUserOption } from "./AskUserCard.js";

/** One section of a grouped exchange. The binding owns the answers; the kit
 * owns their presentation, validation and movement between sections. */
export interface AskUserGroupQuestion {
  header: string;
  question: string;
  multi?: boolean;
  options: AskUserOption[];
  /** Current answer, empty until a choice or nonempty Other text exists. */
  answer?: string;
  annotation?: { preview: string };
  otherOpen?: boolean;
  otherText?: string;
  onOtherChange?: (value: string) => void;
  onOtherSubmit?: (value: string) => void;
  preview?: ReactNode;
}

export interface AskUserGroupCardProps {
  id: string;
  questions: AskUserGroupQuestion[];
  state?: "pending" | "answered" | "dismissed";
  prompt?: string;
  answerMeta?: string;
  lapsedNote?: string;
  onSubmit?: (answers: Record<string, string>, annotations?: Record<string, { preview: string }>) => void;
  onDismiss?: () => void;
  onAskAgain?: () => void;
}

const position: CSSProperties = { font: `400 10.5px/1.4 ${font.mono}`, color: color.inkMute };
const questionStyle: CSSProperties = { font: `400 13px/1.55 ${font.body}`, margin: "0 0 10px", overflowWrap: "anywhere" };
const sectionHead: CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 8 };
const actions: CSSProperties = { display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 8, marginTop: 12 };
const buttonTarget: CSSProperties = { minHeight: 44, maxWidth: "100%" };
const metaStyle: CSSProperties = { font: `400 9.5px/1.4 ${font.mono}`, color: color.inkMute };

/** Two to four questions are one exchange (#541): one header, one primary
 * action and one lasting record. Arrival never takes focus from the composer. */
export function AskUserGroupCard(p: AskUserGroupCardProps) {
  const state = p.state ?? "pending";
  const pending = state === "pending";
  const answered = state === "answered";
  const dismissed = state === "dismissed";
  const hue = dismissed ? accent.gold.ink : accent.teal.ink;
  const root = useRef<HTMLDivElement>(null);
  const [flagged, setFlagged] = useState(false);
  const [announcement, setAnnouncement] = useState({ text: "", sequence: 0 });
  const count = p.questions.filter((q) => Boolean(q.answer?.trim())).length;
  const complete = count === p.questions.length;
  const wasComplete = useRef(complete);

  function announce(text: string) {
    // Repeating the validation action still announces once, even when its
    // wording is unchanged. Picks only update the visible progress cue.
    setAnnouncement((previous) => ({ text, sequence: previous.sequence + 1 }));
  }

  useEffect(() => {
    if (pending && complete && !wasComplete.current) {
      announce(`All ${p.questions.length} answered. Submit is ready.`);
    }
    wasComplete.current = complete;
  }, [complete, pending, p.questions.length]);

  function focusSection(index: number) {
    const group = root.current?.querySelector<HTMLElement>(`[data-question-index="${index}"]`);
    const stop = group?.querySelector<HTMLElement>('[role="radio"][tabindex="0"], [role="checkbox"][tabindex="0"]');
    stop?.focus({ preventScroll: true });
    stop?.scrollIntoView({ block: "nearest" });
  }

  function handOn(index: number) {
    const next = p.questions.findIndex((q, i) => i > index && !q.answer?.trim());
    // Wrap to an earlier gap when revising a later question.
    const first = next < 0 ? p.questions.findIndex((q, i) => i !== index && !q.answer?.trim()) : next;
    if (first >= 0) focusSection(first);
    else root.current?.querySelector<HTMLElement>("[data-group-primary] [role=button]")?.focus();
  }

  function submit() {
    if (!complete) {
      const first = p.questions.findIndex((q) => !q.answer?.trim());
      const left = p.questions.length - count;
      setFlagged(true);
      focusSection(first);
      announce(`${left} ${left === 1 ? "question still needs" : "questions still need"} an answer. Moved to ${p.questions[first]!.header}.`);
      return;
    }
    const answers = Object.fromEntries(p.questions.map((q) => [q.question, q.answer!]));
    const annotations = Object.fromEntries(p.questions.filter((q) => q.annotation).map((q) => [q.question, q.annotation!]));
    announce(`All ${p.questions.length} answered. Submitted.`);
    p.onSubmit?.(answers, Object.keys(annotations).length ? annotations : undefined);
  }

  const head = pending ? p.prompt ?? "Brain needs your input" : answered
    ? `Answered · ${p.questions.length} questions` : "Unanswered — the turn ended";
  return (
    <div ref={root} className="bk-ask-group" data-ask-group={state} style={{
      border: `1px solid ${token(dismissed ? "ask-border-gold" : "ask-border-teal")}`,
      background: color.surface, borderRadius: 14, padding: "13px 13px 12px", boxSizing: "border-box", width: "100%", minWidth: 0,
    }}>
      <div data-group-head style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "8px 14px", marginBottom: 11 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6, font: `500 10px/1.4 ${font.mono}`, letterSpacing: ".08em", textTransform: "uppercase", color: hue, minWidth: 0 }}>
          <Icon icon={pending ? "ask" : answered ? "resolved" : "later"} size={13} color={hue} />{head}
        </span>
        {pending ? <span style={{ ...position, marginLeft: "auto" }}>{count} of {p.questions.length} answered</span> : null}
      </div>
      {pending ? (
        <>
          {p.questions.map((q, i) => (
            <QuestionSection key={`${p.id}-${i}`} id={`${p.id}-${i}`} question={q} index={i} total={p.questions.length}
              flagged={flagged && !q.answer?.trim()} handOn={() => handOn(i)} />
          ))}
          <div data-group-actions style={actions}>
            <Button label="Dismiss" tone="quiet" size="sm" block={false} style={buttonTarget} onClick={p.onDismiss} />
            <div data-group-primary><Button label={complete ? "Submit" : "Go to unanswered"} tone="affirm" size="sm" block={false} style={buttonTarget} onClick={p.onSubmit ? submit : undefined} /></div>
          </div>
          <div data-group-live aria-live="polite" aria-atomic="true" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap" }}><span key={announcement.sequence}>{announcement.text}</span></div>
        </>
      ) : (
        <>
          <div data-group-record style={answered ? { background: token("inset-well-bg"), border: `1px solid ${token("ask-answer-border-teal")}`, borderRadius: 11, padding: "10px 12px" } : undefined}>
            {p.questions.map((q, i) => (
              <div data-group-record-row key={`${p.id}-${i}`} style={{ marginTop: i ? 14 : 0 }}>
                <div style={sectionHead}><Chip label={q.header} tone={dismissed ? "gold" : "teal"} variant="soft" caps />
                  <span style={{ font: `400 12px/1.5 ${font.body}`, color: color.inkDim, overflowWrap: "anywhere", minWidth: 0 }}>{q.question}</span>
                </div>
                {answered ? <div style={{ display: "flex", gap: 9, alignItems: "flex-start", font: `500 12px/1.4 ${font.mono}`, color: hue, overflowWrap: "anywhere" }}>
                  <Icon icon="confirm" size={13} color={hue} /><span style={{ minWidth: 0 }}>{q.answer}</span>
                </div> : null}
              </div>
            ))}
            {answered ? <div data-group-meta style={{ ...metaStyle, marginTop: 10 }}>{p.answerMeta ?? "you answered"}</div> : null}
          </div>
          {dismissed ? <div data-group-lapsed style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 9, marginTop: 12, background: token("ask-lapsed-tint"), border: `1px solid ${token("ask-lapsed-border")}`, borderRadius: 11, padding: "9px 10px 9px 12px" }}>
            <Icon icon="later" size={13} color={hue} />
            <span style={{ flex: "1 1 120px", minWidth: 0, font: `400 11px/1.5 ${font.mono}`, color: color.inkDim }}>{p.lapsedNote ?? "dismissed · the agent got no answer"}</span>
            {p.onAskAgain ? <Button label="Ask again" tone="quiet" size="sm" block={false} style={buttonTarget} onClick={p.onAskAgain} /> : null}
          </div> : null}
        </>
      )}
    </div>
  );
}

function QuestionSection(p: { id: string; question: AskUserGroupQuestion; index: number; total: number; flagged: boolean; handOn: () => void }) {
  const q = p.question;
  const roving = useRoving(q.options.map((o) => Boolean(o.onClick)), q.options.findIndex((o) => o.selected));
  const group = useRef<HTMLDivElement>(null);
  const hasAnswer = Boolean(q.answer?.trim());
  return (
    <section style={{ borderTop: p.index ? `1px solid ${color.line}` : undefined, marginTop: p.index ? 14 : 0, paddingTop: p.index ? 14 : 0 }}>
      <div style={sectionHead}><Chip label={q.header} tone="teal" variant="soft" caps />
        <span id={`${p.id}-position`} style={{ ...position, color: p.flagged ? accent.red.ink : hasAnswer ? accent.teal.ink : color.inkMute }}>
          {p.index + 1} of {p.total}{p.flagged ? " · needs an answer" : hasAnswer ? " · ✓" : ""}
        </span>
      </div>
      <div id={`${p.id}-question`} style={questionStyle}>{q.question}</div>
      <div ref={group} data-question-index={p.index} role={q.multi ? "group" : "radiogroup"} aria-labelledby={`${p.id}-question`} aria-describedby={`${p.id}-position`} aria-invalid={p.flagged || undefined}
        style={{ display: "flex", flexDirection: "column", gap: 7 }}
        onKeyDownCapture={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          const target = event.target as HTMLElement;
          const option = target.closest<HTMLElement>("[data-group-option]");
          if (!option || target.getAttribute("role") !== (q.multi ? "checkbox" : "radio")) return;
          const index = Number(option.dataset.groupOption);
          const choice = q.options[index]!;
          if (!choice.onClick) return;
          event.preventDefault();
          event.stopPropagation();
          choice.onClick();
          // Other opens an inline field; it cannot resolve an empty answer.
          if (!q.multi && choice.title !== "Other" && !choice.selected) p.handOn();
        }}>
        {q.options.map((o, i) => <div data-group-option={i} key={o.title}>
          <ChoiceOption {...o} multiple={q.multi} tabStop={roving.tabIndexFor(i) === 0} onFocus={o.onClick ? () => { roving.onItemFocus(i); o.onFocus?.(); } : undefined} />
        </div>)}
      </div>
      {q.otherOpen ? <AskOtherField touchTarget label={`Your own answer, ${q.header}`} placeholder="Type your answer…" value={q.otherText ?? ""} onChange={q.onOtherChange} onSubmit={(value) => {
        if (!value.trim()) return;
        q.onOtherSubmit?.(value);
        group.current?.querySelector<HTMLElement>('[data-group-option]:last-child [tabindex]')?.focus({ preventScroll: true });
        if (!q.multi) p.handOn();
      }} /> : null}
      {q.preview}
    </section>
  );
}
