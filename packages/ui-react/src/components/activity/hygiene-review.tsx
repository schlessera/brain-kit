import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { z } from "zod";
import type {
  HygieneInput,
  HygieneReviewCommand,
  HygieneReviewRead,
  InboxActionItem,
  InboxDismissReason,
} from "@schlessera/brain-ui-sdk/protocol";
import {
  Button,
  Callout,
  Disclosure,
  DispositionBar,
  EffectPreview,
  effectLineCount,
  HygieneCard,
  HygieneEnd,
  HygieneBlocker,
  TextButton,
  color,
  font,
  type HygieneCardProps,
} from "@schlessera/brain-ui-kit";
import { useBrainUiRoot } from "../../root-context.js";
import { useInboxStore } from "../../stores/inbox-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { useFinePointer } from "../../hooks/use-fine-pointer.js";
import { isEditableTarget, singleKey } from "../../lib/single-key.js";
import { formatWhen } from "./inbox-model.js";

// A display projection only; the server owns selection, handlers and validation.
const findingDisplay = z.object({
  path: z.string(),
  title: z.string(),
  category: z.string().optional(),
  severity: z.string().nullable().optional(),
  line: z.number().nullable().optional(),
  field: z.string().nullable().optional(),
  excerpt: z.string().nullable().optional(),
  sources: z.array(z.object({ source: z.string() })).optional(),
  handlers: z
    .array(z.object({ name: z.string(), suggestedPath: z.string().optional(), explanation: z.string().optional() }))
    .optional(),
  priorityReason: z
    .object({
      severity: z.string(),
      urgency: z.string(),
      ageDays: z.number().nullable(),
      newerWithSameRank: z.number(),
      tieBreak: z.string(),
    })
    .optional(),
  invalidation: z
    .object({ disposition: z.string(), dispositionOn: z.string().nullable(), changed: z.array(z.string()) })
    .nullable()
    .optional(),
});
const IDLE: HygieneReviewRead = {
  review: { version: 1, status: "idle", position: 0, fixed: 0, dismissed: 0, snoozed: 0 },
  action: null,
};

/** REST carries review position/counts; the existing inbox stream carries the Action. */
export function useHygieneReview() {
  const root = useBrainUiRoot();
  const items = useInboxStore((s) => s.items);
  const online = useInboxStore((s) => s.online);
  const supported = useInboxStore((s) => s.supported);
  const startRequested = useUIStore((s) => s.hygieneReviewRequested);
  const [read, setRead] = useState(IDLE);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  const commandRequest = useRef(0);
  const awaited = useRef<string | null>(null);
  const [focus, setFocus] = useState(0);
  const refresh = useCallback(async () => {
    const token = ++request.current;
    try {
      const next = await root.api.hygieneReview();
      if (token === request.current) {
        setRead(next);
        setError(null);
      }
    } catch {
      /* An older server may advertise inbox without hygiene review. */
    }
  }, [root]);
  const revision = Object.values(items)
    .filter((i) => i.queue === "actions" && i.hygiene)
    .map((i) => `${i.id}:${i.version}:${i.status}`)
    .join("|");
  useEffect(() => {
    if (supported && online) void refresh();
  }, [supported, online, revision, refresh]);
  useEffect(() => {
    setRead(IDLE);
    setLoading(false);
    return () => {
      request.current++;
      commandRequest.current++;
    };
  }, [root]);
  const command = useCallback(
    async (op: HygieneReviewCommand["operation"]) => {
      const token = ++request.current;
      const commandToken = ++commandRequest.current;
      setLoading(true);
      setError(null);
      try {
        const next = await root.api.hygieneCommand(op);
        if (token === request.current) setRead(next);
      } catch {
        if (token === request.current) setError("Couldn't load the review. Check the connection and try again.");
      } finally {
        if (commandToken === commandRequest.current) setLoading(false);
      }
    },
    [root]
  );
  useEffect(() => {
    if (!startRequested) return;
    root.stores.ui.getState().consumeHygieneReviewRequest();
    void command("start");
  }, [startRequested, root, command]);
  useEffect(() => {
    const id = awaited.current;
    if (!id) return;
    const old = items[id];
    if (!old || old.queue !== "actions") return;
    const status = old.hygiene?.outcome?.status;
    const confirmed =
      (old.status === "resolved" && (status === "fixed" || status === "not_detected")) ||
      (old.status === "dismissed" && status === "dismissed") ||
      (old.status === "snoozed" && status === "snoozed");
    if (!confirmed) {
      if (status && ["stale", "refused", "check_failed", "still_detected", "undone"].includes(status))
        awaited.current = null;
      return;
    }
    // Wait for the server's next pointer or complete receipt, never select here.
    if (read.review.pendingActionId === id || (read.review.status === "active" && !read.action)) return;
    awaited.current = null;
    setFocus((n) => n + 1);
  }, [items, read]);
  const streamed = read.review.pendingActionId ? items[read.review.pendingActionId] : undefined;
  const action = streamed?.queue === "actions" ? streamed : read.action;
  return {
    read,
    action,
    error,
    loading,
    command,
    refresh,
    focus,
    onSent: (id: string) => {
      awaited.current = id;
    },
  };
}
export type HygieneController = ReturnType<typeof useHygieneReview>;

export function HygieneReviewStrip({
  controller: c,
  onOpen,
  showEnd = true,
  showStart = true,
  showBlocker = true,
}: {
  controller: HygieneController;
  onOpen: () => void;
  showEnd?: boolean;
  showStart?: boolean;
  showBlocker?: boolean;
}) {
  const root = useBrainUiRoot();
  const [laterOpen, setLaterOpen] = useState(false);
  const items = useInboxStore((s) => s.items);
  const outcomes = useInboxStore((s) => s.outcomes);
  const foreign = Object.entries(outcomes).some(
    ([id, outcome]) =>
      items[id]?.queue === "actions" &&
      (items[id] as InboxActionItem).hygiene &&
      outcome.kind === "receipt" &&
      outcome.by === "elsewhere"
  );
  const end = useRef<HTMLDivElement>(null);
  const r = c.read.review;
  useEffect(() => {
    if (showEnd && c.focus > 0 && r.status === "complete") {
      const frame = requestAnimationFrame(() => {
        if (!isEditableTarget(document.activeElement))
          end.current?.querySelector<HTMLElement>("[data-hygiene-complete]")?.focus();
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [c.focus, r.status, showEnd]);
  function openFile(path: string) {
    root.stores.ui.getState().openPanel("files");
    void root.stores.file.getState().openFile(path);
  }
  const snoozed = Object.values(items).filter(
    (i): i is InboxActionItem => i.queue === "actions" && !!i.hygiene && i.status === "snoozed"
  );
  const dismissedErrors = Object.values(items).filter(
    (i) => i.queue === "actions" && i.status === "dismissed" && i.hygiene?.finding.severity === "error"
  ).length;
  const blocker = r.blocker;
  return (
    <div data-hygiene-review="" className="flex flex-col gap-3">
      {showStart && (r.status === "idle" || r.status === "complete") ? (
        <TextButton label="Start hygiene review" disabled={c.loading} onClick={() => void c.command("start")} />
      ) : null}
      {foreign ? <Callout tone="neutral" text="Resolved on another device" /> : null}
      {c.error ? (
        <Callout tone="red" text={c.error}>
          <TextButton label="Try again" onClick={() => void c.refresh()} />
        </Callout>
      ) : null}
      {r.status === "active" || r.status === "paused" ? (
        <div
          data-hygiene-strip=""
          className="flex flex-wrap items-center gap-2 rounded-[10px] border border-border-subtle px-3 py-1 text-xs"
        >
          <span className="min-w-0 flex-1">
            {r.status === "paused"
              ? "Hygiene review paused"
              : `● Hygiene review · ${r.position} of ${r.counts?.eligibleRemaining ?? "?"} open`}
          </span>
          <TextButton
            label={r.status === "paused" ? "Resume" : "Pause"}
            disabled={c.loading}
            onClick={() => void c.command(r.status === "paused" ? "resume" : "pause")}
          />
        </div>
      ) : null}
      {showBlocker && r.status === "blocked" ? (
        <HygieneBlocker
          reason={
            typeof blocker?.message === "string"
              ? blocker.message
              : typeof blocker?.reason === "string"
              ? blocker.reason
              : "configuration unavailable"
          }
          onOpen={() => openFile("brain.config.ts")}
          onRetry={() => void c.command("start")}
          busy={c.loading}
        />
      ) : null}
      {showEnd && r.status === "complete" ? (
        <div ref={end}>
          <HygieneEnd
            empty={r.position === 0}
            fixed={r.position === 0 ? r.counts?.fixed ?? r.fixed : r.fixed}
            dismissed={r.position === 0 ? r.counts?.dismissed ?? r.dismissed : r.dismissed}
            snoozed={r.snoozed || r.counts?.snoozed || 0}
            due={r.counts?.nextSnoozeDueAt ? formatWhen(Date.parse(r.counts.nextSnoozeDueAt)) : undefined}
            informational={r.counts?.informationalNotShown ?? 0}
            dismissedErrors={dismissedErrors}
            onShowSnoozed={() => setLaterOpen(true)}
          />
        </div>
      ) : null}
      {laterOpen ? (
        <div data-hygiene-later="">
          <Disclosure
            label={`Later · ${r.counts?.snoozed ?? snoozed.length}`}
            open={laterOpen}
            onOpenChange={setLaterOpen}
          >
            {snoozed.map((i) => (
              <div key={i.id} className="text-xs">
                {i.payload.title} · back {i.waitUntil ? formatWhen(i.waitUntil) : "at the next scheduled time"}
                <TextButton label="Open finding ›" onClick={onOpen} />
              </div>
            ))}
            {snoozed.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Deferred findings are recorded in context/hygiene/snoozed.md.
                <TextButton label="Open snoozed findings ›" onClick={() => openFile("context/hygiene/snoozed.md")} />
              </p>
            ) : null}
          </Disclosure>
        </div>
      ) : null}
    </div>
  );
}

const REASONS: Array<[InboxDismissReason, string]> = [
  ["dont_ask_again", "Don't ask again"],
  ["wrong_call", "Wrong call"],
  ["need_more_info", "Need more info"],
  ["no_longer_relevant", "No longer relevant"],
];
export function HygieneFinding({
  item,
  controller: c,
  compact = false,
  onOpen,
}: {
  item: InboxActionItem;
  controller: HygieneController;
  compact?: boolean;
  onOpen?: () => void;
}) {
  const root = useBrainUiRoot();
  const flight = useInboxStore((s) => s.inFlight[item.id]);
  const outcome = useInboxStore((s) => s.outcomes[item.id]);
  const online = useInboxStore((s) => s.online);
  const keys = useUIStore((s) => s.singleKeyShortcuts);
  const fine = useFinePointer();
  const data = findingDisplay.safeParse(item.hygiene?.finding);
  const f = data.success ? data.data : { path: item.payload.detail, title: item.payload.title };
  const repairs = item.options.filter((o) => o.effect.kind === "hygiene" && o.effect.operation === "resolve");
  const [selected, setSelected] = useState(repairs[0]?.id ?? "check");
  const [value, setValue] = useState("");
  const [mode, setMode] = useState<"idle" | "later" | "dismiss" | "undo">("idle");
  const [reason, setReason] = useState<InboxDismissReason | undefined>();
  const [why, setWhy] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const inputId = useId(),
    errorId = useId();
  const option = item.options.find((o) => o.id === selected);
  const inverse = item.options.find((o) => o.id === "undo");
  const inputType = option?.input?.type ?? "none";
  let input: HygieneInput = null;
  if (inputType === "strings") {
    try {
      input = JSON.parse(value);
    } catch {
      input = value;
    }
  } else if (inputType !== "none") input = value;
  const matches = option?.effect.kind === "hygiene" && JSON.stringify(option.effect.input) === JSON.stringify(input);
  const hasPreview = !!option?.preview && matches && !!(option.effect.kind === "hygiene" && option.effect.previewToken);
  const fieldError = item.hygiene?.outcome?.fieldError?.message;
  const typingError =
    inputType === "none"
      ? null
      : fieldError ??
        (inputType === "date"
          ? `Use YYYY-MM-DD, for example ${option?.input?.example ?? "2026-07-12"}.`
          : `Enter ${f.field ?? "a note path"} and check its preview.`);
  const needsReveal =
    effectLineCount(option?.preview?.changes.map((c) => `− ${c.before}\n+ ${c.after}`).join("\n")) > 12 && !revealed;
  const locked =
    !online || !!flight || previewing || item.status !== "pending" || item.hygiene?.outcome?.status === "applying";
  const disabledReason = !online
    ? "Reconnect before answering."
    : previewing
    ? "Checking the input…"
    : repairs.length && !hasPreview
    ? typingError ?? "Choose a fix with a valid preview."
    : needsReveal
    ? "Show the complete change before applying."
    : undefined;
  useEffect(() => {
    if (c.focus > 0 && !compact && !isEditableTarget(document.activeElement))
      card.current?.querySelector<HTMLElement>("[data-hygiene-title]")?.focus();
  }, [c.focus, compact]);
  async function preview() {
    if (!option || locked) return;
    setPreviewing(true);
    setPreviewError(null);
    try {
      await root.api.hygienePreview({ itemId: item.id, optionId: option.id, expectedVersion: item.version, input });
      await c.refresh();
    } catch {
      setPreviewError("Couldn't check this input. Nothing was written. Try again.");
    } finally {
      setPreviewing(false);
    }
  }
  function send(id: string) {
    const opt = item.options.find((o) => o.id === id);
    const state = root.stores.inbox.getState();
    if (
      locked ||
      !opt ||
      state.inFlight[item.id] ||
      (id === selected && repairs.length && (!hasPreview || needsReveal))
    )
      return;
    const kind = id === "later" ? "later" : id === "dismiss" ? "dismiss" : "commit";
    if (
      !state.beginDecision(item.id, {
        kind,
        optionId: id,
        label: opt.label,
        receipt: id === "later" ? "Snoozed" : id === "dismiss" ? "Dismissed" : "Fixed · re-checked",
        ...(reason ? { reason } : {}),
        ambiguous: true,
      })
    )
      return;
    const sent = root.connection.send({
      type: "inbox_resolve",
      itemId: item.id,
      optionId: id,
      ...(id === "dismiss" && reason ? { reason } : {}),
      ...(opt.effect.kind === "hygiene" && opt.effect.operation === "resolve" ? { input: opt.effect.input } : {}),
    });
    if (!sent) {
      root.stores.inbox.getState().decisionRefused();
      return;
    }
    c.onSent(item.id);
    setMode("idle");
  }
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (!keys || compact) return;
    const key = singleKey(e);
    if (!["a", "l", "d"].includes(key ?? "")) return;
    e.preventDefault();
    if (key === "a") send(selected);
    else if (!locked) setMode(key === "l" ? "later" : "dismiss");
  }
  function openFile() {
    root.stores.ui.getState().openPanel("files");
    void root.stores.file.getState().openFile(f.path);
  }
  const reasonData = f.priorityReason;
  const priority = reasonData
    ? `${
        reasonData.severity === "error"
          ? "must fix (validation error)"
          : reasonData.severity === "info"
          ? "info · reviewed after every must-fix and warning"
          : reasonData.severity
      } · urgency ${reasonData.urgency} · ${
        reasonData.ageDays === null ? "age unknown" : `open ${reasonData.ageDays} days`
      }\n${reasonData.newerWithSameRank} other findings with the same priority are newer · ${
        reasonData.tieBreak === "identity"
          ? "tie broken by identity"
          : `selected by ${reasonData.tieBreak.replace(/-/g, " ")}`
      }`
    : "urgency unknown";
  const status = item.hygiene?.outcome?.status;
  const unknown =
    flight?.state === "unconfirmed" ||
    outcome?.kind === "not-received" ||
    item.hygiene?.outcome?.code === "receipt-unknown";
  const cardState: HygieneCardProps["state"] = unknown
    ? "unknown"
    : status === "applying" || flight?.state === "applying"
    ? "applying"
    : status === "refused" && item.hygiene?.outcome?.fieldError
    ? undefined
    : status === "stale" ||
      status === "refused" ||
      status === "check_failed" ||
      status === "still_detected" ||
      status === "fixed" ||
      status === "undone"
    ? status
    : outcome?.kind === "not-applied"
    ? "refused"
    : undefined;
  const parsedSources = f.sources?.map((p) => (p.source === "audit" ? "hygiene" : p.source)) ?? [];
  const sources = [...new Set(parsedSources)];
  const invalidation = f.invalidation
    ? `Evidence changed since you ${f.invalidation.disposition === "dismissed" ? "dismissed" : "snoozed"} it on ${
        f.invalidation.dispositionOn ?? "an unknown date"
      }: ${f.invalidation.changed
        .map(
          (field) =>
            ({
              target: "the link target",
              tokens: "the link text",
              value: "the field value",
              severity: "severity",
              urgency: "urgency",
            }[field] ?? field.replace(/-/g, " "))
        )
        .join(", ")} changed.`
    : undefined;
  const controlStyle = {
    minHeight: 44,
    width: "100%",
    boxSizing: "border-box" as const,
    border: `1px solid ${fieldError ? "var(--bk-red-ink)" : color.edge}`,
    borderRadius: 8,
    padding: "10px 12px",
    background: color.canvas,
    color: color.ink,
    font: `400 13px/1.5 ${font.body}`,
  };
  const field =
    inputType !== "none" ? (
      <div className="flex flex-col gap-2">
        <label htmlFor={inputId} style={{ font: `500 10px/1.5 ${font.mono}`, color: color.inkMute }}>
          {f.field ?? "Note path"}
          {inputType === "date"
            ? " (YYYY-MM-DD)"
            : inputType === "strings"
            ? " (JSON list)"
            : inputType === "enum"
            ? " (choose a value)"
            : ""}
        </label>
        {inputType === "enum" ? (
          <select
            id={inputId}
            value={value}
            disabled={locked}
            aria-describedby={errorId}
            aria-invalid={!!fieldError}
            style={controlStyle}
            onChange={(e) => {
              setValue(e.target.value);
              setRevealed(false);
            }}
          >
            <option value="">Choose…</option>
            {option?.input?.values?.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        ) : (
          <input
            id={inputId}
            type="text"
            value={value}
            disabled={locked}
            aria-describedby={errorId}
            aria-invalid={!!fieldError}
            style={controlStyle}
            onChange={(e) => {
              setValue(e.target.value);
              setRevealed(false);
            }}
          />
        )}
        <div
          id={errorId}
          style={{ color: fieldError ? "var(--bk-red-ink)" : color.inkMute, font: `400 11.5px/1.5 ${font.body}` }}
        >
          {fieldError ?? typingError}
        </div>
        <TextButton label="Check preview" disabled={locked || !value} onClick={() => void preview()} />
      </div>
    ) : null;
  const controls = repairs.length ? (
    <>
      {f.category === "broken-link" ? (
        <div role="radiogroup" aria-label="Fix: broken link" className="flex flex-col gap-2">
          {repairs.map((o) => {
            const name =
              o.id === "link-suggested"
                ? `Link to ${
                    f.handlers?.find((h) => h.name === o.id)?.suggestedPath ??
                    o.preview?.changes[0]?.after.match(/^\[\[([^|\]]+)/u)?.[1] ??
                    "the suggested note"
                  }`
                : o.id === "link-note"
                ? "Link to another note…"
                : "Keep the text, remove the link";
            return (
              <label
                key={o.id}
                style={{
                  ...controlStyle,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  borderColor: selected === o.id ? "var(--bk-teal-ink)" : color.edge,
                }}
              >
                <input
                  type="radio"
                  name={`${inputId}-fix`}
                  value={o.id}
                  checked={selected === o.id}
                  disabled={locked}
                  onChange={() => {
                    setSelected(o.id);
                    setValue("");
                    setRevealed(false);
                  }}
                  style={{ accentColor: "var(--bk-teal-ink)" }}
                />
                {name}
              </label>
            );
          })}
        </div>
      ) : null}
      {field}
      {inputType === "none" && !hasPreview ? (
        <TextButton label="Check preview" disabled={locked} onClick={() => void preview()} />
      ) : null}
    </>
  ) : (
    <>
      <TextButton label="Open file ›" onClick={openFile} />
      <p className="text-xs text-muted-foreground">
        {f.handlers?.[0]?.explanation ?? "Edit this finding in the file, then check again."}
      </p>
    </>
  );
  const recovery = (
    <div className="flex flex-wrap gap-2">
      {cardState === "stale" ? (
        <TextButton label="Refresh finding" disabled={locked} onClick={() => void c.command("refresh")} />
      ) : null}
      {cardState === "refused" ? (
        <TextButton
          label="Try again"
          disabled={locked}
          onClick={() => (inputType === "none" && hasPreview ? send(selected) : void preview())}
        />
      ) : null}
      {cardState === "unknown" ? (
        <TextButton
          label="Check again"
          disabled={!online || (!!flight && flight.state === "applying")}
          onClick={() => {
            c.onSent(item.id);
            root.connection.send({ type: "inbox_resolve", itemId: item.id, optionId: "check" });
            root.connection.send({ type: "inbox_subscribe", view: "actions" });
            void c.refresh();
          }}
        />
      ) : null}
      {cardState === "check_failed" ? (
        <>
          <TextButton label="Open file ›" onClick={openFile} />
          {inverse?.preview ? (
            <TextButton label="Undo change" disabled={locked} onClick={() => setMode("undo")} />
          ) : null}
        </>
      ) : null}
    </div>
  );
  const confirmation =
    mode === "later" ? (
      <div data-hygiene-later-confirm="">
        <Callout tone="neutral" text="Later → back at the next scheduled time" />
        <DispositionBar
          commit={{
            label: "Snooze",
            name: "Snooze until the next scheduled time",
            disabled: locked,
            onClick: () => send("later"),
          }}
          dismiss={{ label: "Cancel", onClick: () => setMode("idle") }}
        />
      </div>
    ) : mode === "dismiss" ? (
      <div data-hygiene-dismiss-confirm="">
        <Callout
          tone="neutral"
          text="Dismiss this finding? It won't come back unless the problem changes. Validation still reports it."
        />
        <div className="flex flex-wrap gap-2">
          {REASONS.map(([r, label]) => (
            <Button
              key={r}
              tone={reason === r ? "suggest" : "quiet"}
              size="sm"
              block={false}
              style={{ minHeight: 44 }}
              label={label}
              onClick={() => setReason(reason === r ? undefined : r)}
            />
          ))}
        </div>
        <DispositionBar
          commit={{
            label: "Dismiss",
            name: "Confirm dismiss finding",
            disabled: locked,
            onClick: () => send("dismiss"),
          }}
          dismiss={{ label: "Keep", onClick: () => setMode("idle") }}
        />
      </div>
    ) : mode === "undo" && inverse?.preview ? (
      <div data-hygiene-undo-confirm="">
        <EffectPreview
          heading="Undo change · inverse preview"
          path={inverse.preview.path}
          input={inverse.preview.changes.map((c) => `− ${c.before}\n+ ${c.after}`).join("\n")}
          revealed
        />
        <DispositionBar
          commit={{ label: "Confirm undo", disabled: locked, onClick: () => send("undo") }}
          dismiss={{ label: "Cancel", onClick: () => setMode("idle") }}
        />
      </div>
    ) : null;
  return (
    <div ref={card} data-hygiene-id={item.id} onKeyDown={onKey}>
      {outcome?.kind === "receipt" && outcome.by === "elsewhere" && item.status !== "pending" ? (
        <Callout tone="neutral" text="Resolved on another device" />
      ) : null}
      {item.status === "snoozed" && item.waitUntil ? (
        <Callout tone="neutral" text={`Later · back ${formatWhen(item.waitUntil)}`} />
      ) : null}
      <HygieneCard
        title={f.title}
        severity={
          f.severity === "error" || f.severity === "warning" ? "MUST FIX" : f.severity === "info" ? "INFO" : "REVIEW"
        }
        category={f.category?.replace(/-/g, " ") ?? "finding"}
        path={f.path}
        location={f.field ? `field ${f.field}` : f.line ? `line ${f.line}` : undefined}
        excerpt={f.excerpt ?? undefined}
        provenance={`${sources.join(" + ") || "hygiene"}${sources.length > 1 ? " · same finding" : ""}`}
        priority={priority}
        compact={compact}
        onOpen={onOpen}
        whyOpen={why}
        onWhy={() => setWhy(!why)}
        invalidation={invalidation}
        controls={controls}
        state={cardState}
        reason={item.hygiene?.outcome?.reason}
        code={item.hygiene?.outcome?.code}
        recovery={recovery}
        preview={hasPreview ? option?.preview : undefined}
        previewRevealed={revealed}
        onReveal={() => setRevealed(true)}
        postCheck={
          repairs.length
            ? f.category === "broken-link"
              ? "Then re-checks the link before calling it fixed."
              : "Then re-runs validation on this file."
            : undefined
        }
        commit={{
          label: repairs.length ? "Apply fix" : "Done, check again",
          disabled: locked || !!disabledReason,
          onClick: () => send(selected),
        }}
        later={{ label: "Later ▾", disabled: locked, onClick: () => setMode("later") }}
        dismiss={{ label: "Dismiss", disabled: locked, onClick: () => setMode("dismiss") }}
        disabledReason={disabledReason ?? previewError ?? undefined}
        confirmation={confirmation}
        keys={keys && fine}
      />
    </div>
  );
}
