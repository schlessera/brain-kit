import { useId, useRef, useState } from "react";
import { ChoiceOption } from "../rows/ChoiceOption.js";
import { useRoving } from "../internal/roving.js";
import { Button } from "../primitives/Button.js";
import { Icon, type IconName } from "../primitives/Icon.js";
import { InlineToast } from "../conversation/InlineToast.js";
import {
  ScaleList,
  type AskUserListItem,
  type AskUserListOption,
} from "./AskUserListCard.js";
import { RankList } from "./AskUserRankCard.js";
import { accent, color, font, token } from "../tokens.js";

/** Presentational types: structurally compatible with the SDK, without a runtime SDK dependency. */
export interface FormNodeBase {
  id: string;
  prompt: string;
  header?: string;
  required?: boolean;
  showIf?: { node: string; anyOf: string[] };
}
export interface FormOption {
  label: string;
  description?: string;
  preview?: string;
}
export type FormNode = FormNodeBase &
  (
    | { kind: "single" | "multi"; options: FormOption[] }
    | {
        kind: "scale";
        scale: AskUserListOption[];
        items: AskUserListItem[];
        notes?: boolean;
      }
    | { kind: "rank"; items: AskUserListItem[]; cutoff?: number }
    | { kind: "text" }
  );
export type FormAnswer =
  | { value: string; other?: boolean }
  | { values: string[]; other?: string }
  | {
      answers: Record<string, string>;
      skipped: string[];
      notes?: Record<string, string>;
    }
  | { order: string[]; unchanged: boolean }
  | string;
export type FormAnswers = Record<string, FormAnswer>;
export interface AskUserFormSubmission {
  answers: FormAnswers;
  visibleNodes: string[];
}
export interface AskUserFormCardProps {
  id?: string;
  state?: "pending" | "answered" | "dismissed";
  prompt?: string;
  /**
   * The answered head, replaced. For an answer that is recorded on the card
   * but not yet confirmed by its host, which must not read "Answered" (#910).
   */
  recordHead?: string;
  /** The answered head's icon, replaced alongside `recordHead`. */
  recordIcon?: IconName;
  question: string;
  nodes: FormNode[];
  answers?: FormAnswers;
  answerMeta?: string;
  lapsedNote?: string;
  singleKeys?: boolean;
  onSubmit?: (result: AskUserFormSubmission) => void;
  onDismiss?: () => void;
  onAskAgain?: () => void;
}
function own(answers: FormAnswers, id: string): FormAnswer | undefined {
  return Object.hasOwn(answers, id) ? answers[id] : undefined;
}
function selections(answer: FormAnswer | undefined): string[] {
  return answer && typeof answer !== "string"
    ? "value" in answer
      ? answer.other
        ? []
        : [answer.value]
      : "values" in answer
        ? answer.values
        : []
    : [];
}
function visibleIds(nodes: FormNode[], answers: FormAnswers): Set<string> {
  const visible = new Set<string>();
  for (const node of nodes)
    if (
      !node.showIf ||
      (visible.has(node.showIf.node) &&
        node.showIf.anyOf.some((label) =>
          selections(own(answers, node.showIf!.node)).includes(label),
        ))
    )
      visible.add(node.id);
  return visible;
}
function complete(node: FormNode, answer: FormAnswer | undefined): boolean {
  if (node.kind === "rank") return true;
  if (node.kind === "text")
    return typeof answer === "string" && !!answer.trim();
  if (!answer || typeof answer === "string") return false;
  if (node.kind === "single") return "value" in answer && !!answer.value.trim();
  if (node.kind === "multi")
    return (
      "values" in answer && (!!answer.values.length || !!answer.other?.trim())
    );
  return (
    "answers" in answer &&
    node.kind === "scale" &&
    node.items.every((item) => Object.hasOwn(answer.answers, item.id))
  );
}
function countAnswer(answer: FormAnswer | undefined): number {
  if (!answer) return 0;
  if (typeof answer === "string") return answer.trim() ? 1 : 0;
  return "values" in answer
    ? answer.values.length + (answer.other?.trim() ? 1 : 0)
    : "answers" in answer
      ? Object.keys(answer.answers).length
      : "order" in answer
        ? answer.order.length
        : answer.value.trim()
          ? 1
          : 0;
}
function pathTo(node: FormNode, nodes: FormNode[]): FormNode[] {
  const path = [node];
  let parent =
    node.showIf && nodes.find((entry) => entry.id === node.showIf!.node);
  while (parent) {
    path.unshift(parent);
    parent =
      parent.showIf && nodes.find((entry) => entry.id === parent!.showIf!.node);
  }
  return path;
}
interface SummaryRecord {
  id: string;
  heading?: string;
  lines: string[];
  more?: { label: string; lines: string[] };
}
function summaryRecords(
  nodes: FormNode[],
  answers: FormAnswers,
): SummaryRecord[] {
  const visible = visibleIds(nodes, answers);
  const records: SummaryRecord[] = [];
  for (const node of nodes) {
    if (!visible.has(node.id)) continue;
    if (
      (node.kind === "single" || node.kind === "multi") &&
      nodes.some(
        (child) => visible.has(child.id) && child.showIf?.node === node.id,
      )
    )
      continue;
    const path = pathTo(node, nodes)
      .slice(0, -1)
      .map((parent) => selections(own(answers, parent.id)).join(" · "))
      .filter(Boolean);
    const answer = own(answers, node.id);
    const record: SummaryRecord = { id: node.id, lines: [] };
    if (node.kind === "rank") {
      const order =
        answer && typeof answer !== "string" && "order" in answer
          ? answer.order
          : node.items.map((item) => item.id);
      const labels = new Map(node.items.map((item) => [item.id, item.label]));
      const count = node.cutoff ?? Math.min(5, order.length);
      record.heading = path.length
        ? path.join(" → ")
        : (node.header ?? node.prompt);
      record.lines = order
        .slice(0, count)
        .map((id, i) => `${i + 1}. ${labels.get(id) ?? id}`);
      if (count < order.length)
        record.more = {
          label: `+${order.length - count} ${node.cutoff ? "not ranked" : "more, in order"}`,
          lines: order
            .slice(count)
            .map(
              (id, i) =>
                `${node.cutoff ? "–" : `${i + count + 1}.`} ${labels.get(id) ?? id}`,
            ),
        };
    } else if (
      node.kind === "scale" &&
      answer &&
      typeof answer !== "string" &&
      "answers" in answer
    ) {
      record.heading = path.length
        ? path.join(" → ")
        : (node.header ?? node.prompt);
      for (const option of node.scale) {
        const group = node.items
          .filter((item) => answer.answers[item.id] === option.label)
          .map((item) => item.label);
        if (group.length)
          record.lines.push(`${option.label}: ${group.join(" · ")}`);
      }
      if (answer.skipped.length)
        record.lines.push(`${answer.skipped.length} skipped`);
      for (const item of node.items)
        if (answer.notes?.[item.id])
          record.lines.push(`${item.label}: “${answer.notes[item.id]}”`);
    } else {
      const value =
        typeof answer === "string"
          ? `“${answer}”`
          : answer && "value" in answer
            ? answer.value
            : answer && "values" in answer
              ? [
                  ...answer.values,
                  ...(answer.other ? [answer.other] : []),
                ].join(" · ")
              : "";
      record.lines = [
        value
          ? [...path, value].join(" → ")
          : `${node.header ?? node.prompt} — skipped`,
      ];
    }
    records.push(record);
  }
  return records;
}
function FormRecord({ record }: { record: SummaryRecord }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="bk-form-summary-answer" data-form-answer={record.id}>
      {record.heading ? <p>{record.heading}</p> : null}
      {[...record.lines, ...(expanded ? (record.more?.lines ?? []) : [])].map(
        (line, index) => (
          <p key={index}>{line}</p>
        ),
      )}
      {record.more ? (
        <Button
          label={expanded ? "Show less" : record.more.label}
          tone="quiet"
          size="sm"
          block={false}
          onClick={() => setExpanded(!expanded)}
        />
      ) : null}
    </div>
  );
}

/** One outer shell; branch slots sit below the entire parent's option group. */
export function AskUserFormCard(p: AskUserFormCardProps) {
  const generated = useId(),
    id = p.id ?? `form-${generated}`;
  const state = p.state ?? "pending";
  const root = useRef<HTMLDivElement>(null);
  const [answers, setAnswers] = useState<FormAnswers>(() => p.answers ?? {});
  const [flagged, setFlagged] = useState(new Set<string>());
  const [moving, setMoving] = useState<Record<string, string>>({});
  const [live, setLive] = useState("");
  const [focusedKind, setFocusedKind] = useState<FormNode["kind"]>();
  const [receipt, setReceipt] = useState<{
    parent: string;
    before: FormAnswer | undefined;
    count: number;
  } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [paths, setPaths] = useState(new Set<string>());
  const visible = visibleIds(p.nodes, answers);
  const missing = p.nodes.filter(
    (node) =>
      visible.has(node.id) &&
      node.required !== false &&
      !complete(node, own(answers, node.id)),
  );
  const moved = Object.entries(moving).find(([node]) => visible.has(node))?.[1];
  function focusNode(node: string) {
    root.current
      ?.querySelector<HTMLElement>(
        `[data-form-node="${CSS.escape(node)}"] [tabindex="0"], [data-form-node="${CSS.escape(node)}"] textarea`,
      )
      ?.focus({ preventScroll: true });
  }
  function change(node: FormNode, value: FormAnswer) {
    const next = { ...answers, [node.id]: value };
    const after = visibleIds(p.nodes, next);
    const removed = p.nodes.filter(
      (entry) => visible.has(entry.id) && !after.has(entry.id),
    );
    const added = p.nodes.filter(
      (entry) => !visible.has(entry.id) && after.has(entry.id),
    );
    const count = removed.reduce(
      (total, entry) => total + countAnswer(own(answers, entry.id)),
      0,
    );
    if (removed.length || added.length) {
      setReceipt(
        count
          ? { parent: node.id, before: own(answers, node.id), count }
          : null,
      );
      setLive(
        [
          added.length
            ? `${added.map((entry) => entry.header ?? entry.prompt).join(", ")} shown.`
            : "",
          removed.length
            ? `${removed.map((entry) => entry.header ?? entry.prompt).join(", ")} hidden.`
            : "",
          count ? `${count} answers set aside. Undo available.` : "",
          `${p.nodes.filter((entry) => after.has(entry.id) && entry.required !== false && !complete(entry, own(next, entry.id))).length} left. Tab to continue.`,
        ]
          .filter(Boolean)
          .join(" "),
      );
      setMoving(
        Object.fromEntries(
          Object.entries(moving).filter(([entry]) => after.has(entry)),
        ),
      );
    }
    setAnswers(next);
    setFlagged(
      new Set(
        [...flagged].filter((entry) => entry !== node.id && after.has(entry)),
      ),
    );
  }
  function submit() {
    if (moved) {
      setLive(`Finish moving ${moved} before submitting.`);
      return;
    }
    if (missing.length) {
      setFlagged(new Set(missing.map((node) => node.id)));
      setLive(
        `${missing.length} questions still need an answer. Moved to ${missing[0]!.prompt}`,
      );
      focusNode(missing[0]!.id);
      return;
    }
    const pairs: [string, FormAnswer][] = [];
    for (const node of p.nodes) {
      if (!visible.has(node.id)) continue;
      const answer = own(answers, node.id);
      if (
        answer !== undefined &&
        (node.kind === "scale" || complete(node, answer))
      )
        pairs.push([
          node.id,
          typeof answer === "string" ? answer.trim() : answer,
        ]);
      else if (node.kind === "rank")
        pairs.push([
          node.id,
          { order: node.items.map((item) => item.id), unchanged: true },
        ]);
    }
    p.onSubmit?.({
      answers: Object.fromEntries(pairs),
      visibleNodes: [...visible],
    });
    setReceipt(null);
  }
  function renderNode(node: FormNode) {
    if (!visible.has(node.id)) return null;
    const answer = own(answers, node.id),
      path = pathTo(node, p.nodes),
      short = path.length > 3 && !paths.has(node.id);
    const crumbs = short ? path.slice(-2) : path;
    const crumbLabel = (entry: FormNode) => {
      const index = path.indexOf(entry);
      return index === 0
        ? (entry.header ?? entry.prompt)
        : selections(own(answers, path[index - 1]!.id))
            .filter((label) => entry.showIf?.anyOf.includes(label))
            .join(" · ");
    };
    return (
      <section
        key={node.id}
        data-form-node={node.id}
        className="bk-form-node"
        role="group"
        aria-labelledby={`${id}-${node.id}-q`}
        aria-describedby={path.length > 1 ? `${id}-${node.id}-path` : undefined}
        aria-invalid={flagged.has(node.id) || undefined}
      >
        <p id={`${id}-${node.id}-q`} className="bk-form-question">
          {node.prompt}
          {node.required === false ? (
            <span className="bk-form-hint"> · optional</span>
          ) : null}
        </p>
        {flagged.has(node.id) ? (
          <p className="bk-form-error">Answer this question to submit.</p>
        ) : null}
        {node.kind === "single" || node.kind === "multi" ? (
          <FormChoice
            node={node}
            answer={answer}
            singleKeys={p.singleKeys !== false}
            onChange={(value) => change(node, value)}
            labelId={`${id}-${node.id}-q`}
          />
        ) : null}
        {node.kind === "text" ? (
          <div className="bk-field">
            <textarea
              rows={1}
              maxLength={280}
              aria-labelledby={`${id}-${node.id}-q`}
              value={typeof answer === "string" ? answer : ""}
              onInput={(event) => {
                event.currentTarget.style.height = "auto";
                event.currentTarget.style.height = `${event.currentTarget.scrollHeight}px`;
                change(node, event.currentTarget.value);
              }}
            />
            <span className="bk-form-hint">
              {typeof answer === "string" ? answer.length : 0}/280
            </span>
          </div>
        ) : null}
        {node.kind === "scale" ? (
          <ScaleList
            id={`${id}-${node.id}`}
            question={node.prompt}
            items={node.items}
            scale={node.scale}
            notes={node.notes}
            singleKeys={p.singleKeys}
            flagged={flagged.has(node.id)}
            answers={
              answer && typeof answer !== "string" && "answers" in answer
                ? answer.answers
                : undefined
            }
            itemNotes={
              answer && typeof answer !== "string" && "notes" in answer
                ? answer.notes
                : undefined
            }
            onChange={(value) =>
              change(node, {
                ...value,
                skipped: node.items
                  .filter((item) => !Object.hasOwn(value.answers, item.id))
                  .map((item) => item.id),
              })
            }
            onComplete={() => {
              const next = p.nodes.find(
                (entry, index) =>
                  index > p.nodes.indexOf(node) && visible.has(entry.id),
              );
              if (next) focusNode(next.id);
              else
                root.current
                  ?.querySelector<HTMLElement>(
                    "[data-form-submit] [role=button]",
                  )
                  ?.focus({ preventScroll: true });
            }}
          />
        ) : null}
        {node.kind === "rank" ? (
          <RankList
            id={`${id}-${node.id}`}
            question={node.prompt}
            items={node.items}
            cutoff={node.cutoff}
            singleKeys={p.singleKeys}
            order={
              answer && typeof answer !== "string" && "order" in answer
                ? answer.order
                : undefined
            }
            onChange={(value) => change(node, value)}
            onMoveChange={(label) =>
              setMoving((previous) => {
                const next = { ...previous };
                if (label) next[node.id] = label;
                else delete next[node.id];
                return next;
              })
            }
          />
        ) : null}
        <div className="bk-form-branch">
          {p.nodes
            .filter((child) => child.showIf?.node === node.id)
            .map(renderNode)}
          {receipt?.parent === node.id ? (
            <div className="bk-form-receipt">
              <InlineToast
                text={`${receipt.count} answers set aside`}
                announce={false}
                target=""
                effect=""
                tone="teal"
                icon="confirm"
                onUndo={() => {
                  const next = { ...answers };
                  if (receipt.before === undefined) delete next[receipt.parent];
                  else next[receipt.parent] = receipt.before;
                  setAnswers(next);
                  setReceipt(null);
                  setMoving({});
                  setLive("Previous branch and answers restored.");
                  focusNode(receipt.parent);
                }}
              />
            </div>
          ) : null}
        </div>
        {path.length > 1 ? (
          <div className="bk-form-path" id={`${id}-${node.id}-path`}>
            {short ? (
              <button
                type="button"
                aria-label={`Show full path to ${node.header ?? node.prompt}`}
                onClick={() => setPaths(new Set(paths).add(node.id))}
              >
                …
              </button>
            ) : null}
            {crumbs.map((entry, index) => (
              <span key={entry.id}>
                {index || short ? <span aria-hidden="true"> › </span> : null}
                <button
                  type="button"
                  aria-label={`Go to ${crumbLabel(entry)}`}
                  onClick={() => focusNode(entry.id)}
                >
                  {crumbLabel(entry)}
                </button>
              </span>
            ))}
          </div>
        ) : null}
      </section>
    );
  }
  const recorded = p.answers ?? answers;
  const records = state === "answered" ? summaryRecords(p.nodes, recorded) : [];
  const longRecord =
    records.length > 4 &&
    records.reduce((total, record) => total + record.lines.length, 0) > 6;
  return (
    <div
      ref={root}
      className="bk-askform"
      data-state={state}
      onFocusCapture={(event) => {
        const nodeId = (event.target as HTMLElement).closest<HTMLElement>(
          "[data-form-node]",
        )?.dataset.formNode;
        if (nodeId)
          setFocusedKind(p.nodes.find((node) => node.id === nodeId)?.kind);
      }}
      role="group"
      aria-labelledby={`${id}-q`}
      style={{
        background: color.surface,
        border: `1px solid ${token(state === "dismissed" ? "ask-border-gold" : "ask-border-teal")}`,
        borderRadius: 14,
        padding: 13,
        minWidth: 0,
      }}
    >
      <div className="bk-form-header">
        <div
          data-form-head=""
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            font: `500 10.5px/1.5 ${font.mono}`,
            color: state === "dismissed" ? accent.gold.ink : accent.teal.ink,
            textTransform: "uppercase",
          }}
        >
          <Icon
            icon={
              state === "answered"
                ? p.recordIcon ?? "resolved"
                : state === "dismissed"
                  ? "later"
                  : "ask"
            }
            size={13}
          />
          {state === "pending"
            ? (p.prompt ?? "Brain needs your input")
            : state === "answered"
              ? p.recordHead ?? "Answered"
              : "Unanswered — the turn ended"}
        </div>
        <div className="bk-form-title">
          <p id={`${id}-q`} className="bk-form-question">
            {p.question}
          </p>
          {state === "pending" ? (
            <span className="bk-form-hint" data-form-progress="">
              {missing.length ? `${missing.length} left` : "Ready"}
            </span>
          ) : null}
        </div>
      </div>
      {state === "pending" ? (
        <>
          {p.nodes.filter((node) => !node.showIf).map(renderNode)}
          <div data-form-actions="" className="bk-form-actions">
            {focusedKind === "rank" ? (
              <span className="bk-rank-keys bk-form-keys" aria-hidden="true">
                space pick up · ↑↓ move
                {p.singleKeys !== false ? " · 1–9 place" : ""}
              </span>
            ) : null}
            <span className="bk-form-hint" aria-live="off">
              {missing.length ? `${missing.length} left` : "Ready"}
            </span>
            <Button
              label="Dismiss"
              tone="quiet"
              size="sm"
              block={false}
              onClick={p.onDismiss}
            />
            <span data-form-submit="" tabIndex={-1}>
              <Button
                label={
                  moved
                    ? `Finish moving ${moved}`
                    : missing.length
                      ? `${missing.length} left to answer`
                      : "Submit"
                }
                tone={missing.length || moved ? "quiet" : "affirm"}
                size="sm"
                block={false}
                ariaDisabled={!!missing.length || !!moved}
                onClick={submit}
              />
            </span>
          </div>
        </>
      ) : state === "answered" ? (
        <>
          <div className="bk-form-record">
            {(longRecord && !expanded ? records.slice(0, 4) : records).map(
              (record) => (
                <FormRecord key={record.id} record={record} />
              ),
            )}
          </div>
          {longRecord ? (
            <Button
              label={
                expanded ? "Show less" : `${records.length - 4} more answers`
              }
              tone="quiet"
              size="sm"
              block={false}
              onClick={() => setExpanded(!expanded)}
            />
          ) : null}
          <p className="bk-form-hint">{p.answerMeta ?? "you answered"}</p>
        </>
      ) : (
        <div className="bk-form-actions">
          <span>{p.lapsedNote ?? "Dismissed"}</span>
          {p.onAskAgain ? (
            <Button
              label="Ask again"
              tone="quiet"
              size="sm"
              block={false}
              onClick={p.onAskAgain}
            />
          ) : null}
        </div>
      )}
      <div aria-live="polite" className="bk-rank-live" data-form-live="">
        {live}
      </div>
    </div>
  );
}
function FormChoice(p: {
  node: FormNode & { kind: "single" | "multi"; options: FormOption[] };
  answer: FormAnswer | undefined;
  singleKeys: boolean;
  labelId: string;
  onChange: (answer: FormAnswer) => void;
}) {
  const answer =
    p.answer && typeof p.answer !== "string" ? p.answer : undefined;
  const multi = p.node.kind === "multi";
  const values = selections(p.answer);
  const other =
    answer &&
    ("value" in answer
      ? answer.other === true
      : "values" in answer && Object.hasOwn(answer, "other"));
  const roving = useRoving(
    [...p.node.options, { label: "Other" }].map(() => true),
    other
      ? p.node.options.length
      : p.node.options.findIndex((option) => values.includes(option.label)),
  );
  const [preview, setPreview] = useState<string | undefined>();
  function pick(label: string, isOther = false) {
    if (!multi)
      p.onChange(isOther ? { value: "", other: true } : { value: label });
    else {
      const selected = values.includes(label)
        ? values.filter((value) => value !== label)
        : [...values, label];
      const custom = answer && "values" in answer ? answer.other : undefined;
      p.onChange({
        values: isOther ? values : selected,
        ...(!isOther && custom !== undefined
          ? { other: custom }
          : isOther && !other
            ? { other: "" }
            : {}),
      });
    }
  }
  return (
    <>
      <div
        className="bk-form-options"
        role={multi ? "group" : "radiogroup"}
        aria-labelledby={p.labelId}
        onKeyDown={(event) => {
          if (
            p.singleKeys &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey &&
            /^[1-9]$/.test(event.key) &&
            event.target === document.activeElement
          ) {
            const option = p.node.options[Number(event.key) - 1];
            if (option) {
              event.preventDefault();
              pick(option.label);
            } else if (Number(event.key) === p.node.options.length + 1) {
              event.preventDefault();
              pick("Other", true);
            }
          }
        }}
      >
        {p.node.options.map((option, index) => (
          <ChoiceOption
            key={option.label}
            title={option.label}
            subtitle={option.description}
            selected={values.includes(option.label)}
            multiple={multi}
            tabStop={roving.stop === index}
            onFocus={() => {
              roving.onItemFocus(index);
              setPreview(option.preview);
            }}
            onClick={() => pick(option.label)}
          />
        ))}
        <ChoiceOption
          title="Other"
          subtitle="Provide a custom answer."
          italic
          dim
          selected={!!other}
          multiple={multi}
          tabStop={roving.stop === p.node.options.length}
          onFocus={() => {
            roving.onItemFocus(p.node.options.length);
            setPreview(undefined);
          }}
          onClick={() => pick("Other", true)}
        />
      </div>
      {multi ? <span className="bk-form-hint">pick any</span> : null}
      {preview ? <pre className="bk-form-preview">{preview}</pre> : null}
      {other ? (
        <div className="bk-field">
          <textarea
            rows={1}
            maxLength={4000}
            aria-label={`Other answer for ${p.node.prompt}`}
            value={
              answer && "value" in answer
                ? answer.value
                : answer && "values" in answer
                  ? (answer.other ?? "")
                  : ""
            }
            onInput={(event) =>
              p.onChange(
                multi
                  ? { values, other: event.currentTarget.value }
                  : { value: event.currentTarget.value, other: true },
              )
            }
          />
        </div>
      ) : null}
    </>
  );
}
