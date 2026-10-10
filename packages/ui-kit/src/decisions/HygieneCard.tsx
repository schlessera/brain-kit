import { useId, type CSSProperties, type ReactNode } from "react";
import { ActionCard } from "./ActionCard.js";
import { EffectPreview } from "./EffectPreview.js";
import { DispositionBar, type DispositionControl } from "./DispositionBar.js";
import { Callout } from "../primitives/Callout.js";
import { PathRef } from "../primitives/PathRef.js";
import { TextButton } from "../primitives/TextButton.js";
import { color, font } from "../tokens.js";

export interface HygieneCardProps {
  title: string;
  severity: string;
  category: string;
  path: string;
  location?: string;
  excerpt?: string;
  provenance: string;
  priority: string;
  whyOpen?: boolean;
  onWhy?: () => void;
  compact?: boolean;
  onOpen?: () => void;
  invalidation?: string;
  controls?: ReactNode;
  preview?: { path: string; changes: Array<{ before: string; after: string; line: number }> };
  previewRevealed?: boolean;
  onReveal?: () => void;
  postCheck?: string;
  state?: "applying" | "stale" | "refused" | "check_failed" | "still_detected" | "unknown" | "fixed" | "undone";
  reason?: string;
  code?: string;
  recovery?: ReactNode;
  commit?: DispositionControl;
  later?: DispositionControl;
  dismiss?: DispositionControl;
  disabledReason?: string;
  confirmation?: ReactNode;
  keys?: boolean;
}

const stack: CSSProperties = { display: "flex", flexDirection: "column", gap: 12, minWidth: 0 };
const mono: CSSProperties = { font: `500 10px/1.5 ${font.mono}`, color: color.inkMute, overflowWrap: "anywhere" };
/** Presentation only. CLI projections, input validation and every effect belong to the caller. */
export function HygieneCard(p: HygieneCardProps) {
  const whyId = useId();
  const stateText =
    p.state === "applying"
      ? "Applying… checking the file first"
      : p.state === "stale"
      ? "This file changed since the finding was shown. Nothing was written."
      : p.state === "refused"
      ? `Couldn't write ${p.path}: ${p.reason ?? "write refused"}. Nothing was changed.`
      : p.state === "check_failed"
      ? `The change was written, but the check still fails: ${p.code ?? "check unavailable"}.`
      : p.state === "unknown"
      ? "Didn't hear back. Checking again won't apply the change twice."
      : p.state === "still_detected"
      ? "Still detected — nothing changed"
      : p.state === "fixed"
      ? "Fixed · re-checked"
      : p.state === "undone"
      ? "Change undone. Review a new preview before applying again."
      : undefined;
  const tone =
    p.state === "stale"
      ? "gold"
      : p.state === "refused" || p.state === "check_failed"
      ? "red"
      : p.state === "fixed"
      ? "teal"
      : "neutral";
  if (p.state === "fixed")
    return (
      <div data-hygiene-card="" role="status">
        <Callout tone="teal" text={`Fixed · re-checked · Finding no longer detected in ${p.path}`} />
      </div>
    );
  return (
    <ActionCard
      kind="choose"
      title=""
      kindLabel={`${p.severity} · ${p.category}`}
      kindLabelTone={p.severity === "MUST FIX" ? "red" : "neutral"}
      headAction={
        !p.compact && p.onWhy ? (
          <TextButton
            tone="meta"
            label="why this one ›"
            expanded={p.whyOpen === true}
            controls={whyId}
            onClick={p.onWhy}
          />
        ) : undefined
      }
      chevron={false}
      footLink={
        p.compact && p.onOpen
          ? { label: "Open finding ›", onClick: p.onOpen, name: `Open finding: ${p.title}` }
          : undefined
      }
    >
      <div style={{ ...stack, containerType: "inline-size", containerName: "bk-hygiene" }} data-hygiene-card="">
        <h3
          tabIndex={-1}
          data-hygiene-title=""
          style={{
            margin: 0,
            font: `600 14px/1.4 ${font.body}`,
            color: color.ink,
            outline: "none",
            overflowWrap: "anywhere",
          }}
        >
          {p.title}
        </h3>
        {!p.compact ? (
          <>
            <div id={whyId} hidden={!p.whyOpen} style={{ ...mono, whiteSpace: "pre-line" }}>
              {p.priority}
            </div>
            <PathRef text={p.path} meta={p.location} variant="inline" />
            {p.excerpt ? (
              <pre
                style={{
                  ...mono,
                  background: color.canvas,
                  borderRadius: 6,
                  padding: 8,
                  margin: 0,
                  whiteSpace: "pre-wrap",
                }}
              >
                {p.excerpt}
              </pre>
            ) : null}
            <div style={mono}>{p.provenance}</div>
            {p.invalidation ? <Callout tone="gold" text={p.invalidation} /> : null}
            {stateText ? (
              <div role="status" data-hygiene-state={p.state}>
                <Callout tone={tone} text={stateText} />
                {p.recovery}
              </div>
            ) : null}
            {p.controls ? (
              <div style={stack}>
                <div style={mono}>FIX IT</div>
                {p.controls}
              </div>
            ) : null}
            {p.preview ? (
              <EffectPreview
                heading="Will change"
                path={p.preview.path}
                input={p.preview.changes.map((c) => `− ${c.before}\n+ ${c.after}`).join("\n")}
                maxLines={12}
                revealed={p.previewRevealed}
                onReveal={p.onReveal}
              />
            ) : null}
            {p.postCheck ? (
              <div style={{ font: `400 11.5px/1.5 ${font.body}`, color: color.inkMute }}>{p.postCheck}</div>
            ) : null}
            <DispositionBar
              commit={p.commit}
              later={p.later}
              dismiss={p.dismiss}
              reason={p.disabledReason}
              busy={p.state === "applying" ? "commit" : undefined}
              busyLabel="Applying… checking the file first"
            />
            {p.confirmation}
            {p.keys ? <div style={mono}>a Apply · l Later · d Dismiss</div> : null}
            <div style={{ ...mono, borderTop: `1px solid ${color.line}`, paddingTop: 10 }}>
              PRIORITY
              <br />
              <span style={{ color: color.inkDim }}>{p.priority}</span>
            </div>
          </>
        ) : null}
      </div>
    </ActionCard>
  );
}

export function HygieneEnd({
  empty,
  fixed,
  dismissed,
  snoozed,
  due,
  informational,
  dismissedErrors = 0,
  onShowSnoozed,
}: {
  empty: boolean;
  fixed: number;
  dismissed: number;
  snoozed: number;
  due?: string;
  informational: number;
  dismissedErrors?: number;
  onShowSnoozed: () => void;
}) {
  return (
    <div data-hygiene-end="" style={{ ...stack, padding: "28px 0" }}>
      <h2
        tabIndex={-1}
        data-hygiene-complete=""
        style={{ font: `600 18px/1.4 ${font.body}`, color: color.ink, textAlign: "center", margin: 0, outline: "none" }}
      >
        {empty ? "No open findings." : "Review complete"}
      </h2>
      {!empty ? (
        <p style={{ margin: 0, textAlign: "center", color: color.inkDim, font: `400 12px/1.5 ${font.body}` }}>
          Nothing else needs you right now.
        </p>
      ) : null}
      <div style={{ ...stack, gap: 6, padding: 14, border: `1px solid ${color.line}`, borderRadius: 10 }}>
        <div style={mono}>This review</div>
        <div style={{ font: `500 12px/1.5 ${font.body}`, color: color.ink }}>
          {fixed} fixed · {dismissed} dismissed · {snoozed} snoozed
        </div>
        {due ? <div style={mono}>next snooze due {due}</div> : null}
        <div style={mono}>{informational} informational markers not shown</div>
      </div>
      {snoozed > 0 ? <TextButton label={`Show snoozed (${snoozed})`} onClick={onShowSnoozed} /> : null}
      {dismissedErrors > 0 ? (
        <p style={{ ...mono, textAlign: "center" }}>
          Validation still reports {dismissedErrors} dismissed {dismissedErrors === 1 ? "error" : "errors"}. Dismissing
          never hides it there.
        </p>
      ) : null}
    </div>
  );
}

export function HygieneBlocker({
  reason,
  onOpen,
  onRetry,
  busy = false,
}: {
  reason: string;
  onOpen: () => void;
  onRetry: () => void;
  busy?: boolean;
}) {
  return (
    <section data-hygiene-blocker="" style={stack}>
      <h2 style={{ margin: 0, font: `600 14px/1.4 ${font.body}`, color: color.ink }}>Review can't start</h2>
      <Callout
        tone="red"
        text={`Validation couldn't load brain.config: ${reason}. Fix the configuration, then start again.`}
      />
      <TextButton label="Open configuration ›" onClick={onOpen} />
      <TextButton label="Start again" disabled={busy} onClick={onRetry} />
    </section>
  );
}
