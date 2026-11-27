import type { CSSProperties } from "react";

import { Button } from "../primitives/Button.js";
import { Chip } from "../primitives/Chip.js";
import { Icon } from "../primitives/Icon.js";
import { accent, color, font, token } from "../tokens.js";

/** Lifecycle state of one network approval card (#4967). */
export type NetworkApprovalState =
  | "pending"
  | "armed"
  | "sending"
  | "updated"
  | "granted"
  | "withdrawn"
  | "expired"
  | "unknown";

/** Explicit approval scopes offered by the host (#3595). */
export type NetworkApprovalScopeChoice = "once" | "origin" | "session";

export interface NetworkApprovalCardProps {
  /** Short origin label shown in headings and buttons (e.g. `example.com`). */
  originLabel: string;
  /** Full canonical origin/authority string, wrapped in full (never truncated). */
  target?: string;
  /** Number of pending connections grouped under this origin. */
  connectionCount?: number;
  /** Plain-language cause or suspended-grant explanation from the host. */
  description?: string;
  /** Managed GitHub acquisitions never offer origin or session grants (#3595). */
  managedReference?: boolean;
  /** Host-advertised scopes; defaults to `["once", "origin", "session"]` (or `["once"]` when managed). */
  scopes?: readonly NetworkApprovalScopeChoice[];
  /** Presentational state; host owns terminal outcomes (#4967). */
  state?: NetworkApprovalState;
  /** Which scope was granted when `state === "granted"`. */
  grantedScope?: NetworkApprovalScopeChoice | "legacy";
  /** Explicit terminal receipt override; sensible defaults per state/scope. */
  outcomeLabel?: string;
  /** Elapsed waiting time label (e.g. `"Waiting 1:12"`). */
  waitingLabel?: string;
  /** Optional countdown label, shown only when the host supplies a deadline. */
  deadlineLabel?: string;
  /** Notice displayed when the card updated in place with new untrusted input. */
  updateNotice?: string;
  /** Optional printed single-key hints (narrowest allow `a`, deny `d`). */
  shortcuts?: { allow: string; deny: string };
  /** Hide the per-card session scope button when the stack shows an aggregate "Allow all N sites" bar. */
  hideSessionButton?: boolean;
  /** Compact mode for the stack above the composer. */
  compact?: boolean;
  onSelectScope?: (scope: NetworkApprovalScopeChoice) => void;
  /** Unscoped legacy allow callback used when `scopes` is explicitly empty (`[]`). */
  onAllow?: () => void;
  onDeny?: () => void;
}

/** Default one-line receipt text for terminal network approval states (#4967). */
export function defaultNetworkOutcomeLabel(
  state: NetworkApprovalState,
  originLabel: string,
  grantedScope?: NetworkApprovalScopeChoice | "legacy"
): string {
  if (state === "granted") {
    if (grantedScope === "once") return `Allowed once · ${originLabel}`;
    if (grantedScope === "session") return "Allowed · all sites · this chat";
    return `Allowed · ${originLabel} · this chat`;
  }
  if (state === "withdrawn") return `Withdrawn · ${originLabel} stopped waiting`;
  if (state === "expired") return `Expired · ${originLabel} · chat turn ended`;
  if (state === "unknown") return "This request had already closed — nothing ran";
  return "";
}

/**
 * Compact network-approval card for the stack above the composer and its
 * one-line terminal receipt in the transcript (#4967, #3595).
 *
 * Presentational only: no stores, no timers, no fetch. Buttons stay 44 px tall
 * and hold identical dimensions between `armed` (`aria-disabled="true"`) and
 * `pending` so arming finishes with zero layout shift.
 */
export function NetworkApprovalCard(p: NetworkApprovalCardProps) {
  const state = p.state ?? "pending";
  const terminal = state === "granted" || state === "withdrawn" || state === "expired" || state === "unknown";

  if (terminal) {
    const label = p.outcomeLabel || defaultNetworkOutcomeLabel(state, p.originLabel, p.grantedScope);
    const toneColor =
      state === "granted"
        ? accent.teal.ink
        : state === "unknown"
          ? accent.red.ink
          : color.inkMute;
    const iconName = state === "granted" ? "resolved" : state === "unknown" ? "failed" : "approval";
    const rowStyle: CSSProperties = {
      display: "flex",
      alignItems: "center",
      gap: 7,
      padding: "6px 10px",
      borderRadius: 10,
      border: `1px solid ${color.edge}`,
      background: "transparent",
      font: `500 11.5px/1.35 ${font.mono}`,
      color: toneColor,
      boxSizing: "border-box",
      width: "100%",
      overflowWrap: "anywhere",
    };
    return (
      <div style={rowStyle} data-kit-network-receipt="" data-network-state={state} role="status">
        <Icon icon={iconName} size={13} color={toneColor} />
        <span style={{ minWidth: 0, flex: 1 }}>{label}</span>
      </div>
    );
  }

  const legacyUnscoped = !p.managedReference && p.scopes !== undefined && p.scopes.length === 0;
  const scopes: readonly NetworkApprovalScopeChoice[] = p.managedReference
    ? ["once"]
    : p.scopes !== undefined
      ? p.scopes
      : ["once", "origin", "session"];
  const offersOnce = scopes.includes("once");
  const offersOrigin = !p.managedReference && scopes.includes("origin");
  const offersSession = !p.managedReference && !p.hideSessionButton && scopes.includes("session");
  const count = p.connectionCount ?? 1;
  const armed = state === "armed";
  const sending = state === "sending";
  const buttonsLocked = armed || sending;
  const heading = count > 1 ? `${p.originLabel} · ${count} connections waiting` : p.originLabel;

  const box: CSSProperties = {
    border: `2px solid ${token("surface-border-amber")}`,
    background: token("surface-tint-amber"),
    borderRadius: 12,
    padding: p.compact ? "10px 11px" : 12,
    boxSizing: "border-box",
    width: "100%",
    display: "flex",
    flexDirection: "column",
    gap: 7,
  };
  const head: CSSProperties = {
    display: "flex",
    alignItems: "flex-start",
    gap: 7,
    flexWrap: "wrap",
    font: `600 12px/1.35 ${font.mono}`,
    color: color.ink,
  };
  const titleStyle: CSSProperties = {
    flex: "1 1 140px",
    minWidth: 0,
    whiteSpace: "normal",
    overflowWrap: "anywhere",
  };
  const metaRow: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
    font: `400 10.5px/1.4 ${font.mono}`,
    color: color.inkMute,
  };
  const descStyle: CSSProperties = {
    margin: 0,
    font: `400 11.5px/1.45 ${font.body}`,
    color: color.inkDim,
    overflowWrap: "anywhere",
  };
  const noticeStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    font: `500 10.5px/1.35 ${font.mono}`,
    color: accent.gold.ink,
  };
  const actionsRow: CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    alignItems: "stretch",
  };
  const scopeRow: CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    alignItems: "stretch",
  };
  const allowMount: CSSProperties = {
    flex: "1 1 130px",
    minWidth: 0,
    minHeight: 44,
    width: "auto",
    ...(armed ? { opacity: 0.72, cursor: "wait" } : null),
  };
  const denyMount: CSSProperties = {
    flex: "0 0 auto",
    minWidth: 96,
    minHeight: 44,
    width: "auto",
    ...(armed ? { opacity: 0.72, cursor: "wait" } : null),
  };
  const secondaryMount: CSSProperties = {
    flex: "1 1 140px",
    minWidth: 0,
    maxWidth: "100%",
    minHeight: 44,
    width: "auto",
    whiteSpace: "normal",
    overflowWrap: "anywhere",
    ...(armed ? { opacity: 0.72, cursor: "wait" } : null),
  };

  const badgeText = sending
    ? "Sending…"
    : armed
      ? "Reviewing…"
      : state === "updated"
        ? "Updated"
        : p.managedReference
          ? "Managed GitHub"
          : "Network approval";

  const fireScope = (scope: NetworkApprovalScopeChoice) => {
    if (buttonsLocked) return;
    p.onSelectScope?.(scope);
  };
  const fireAllow = () => {
    if (buttonsLocked) return;
    p.onAllow?.();
  };
  const fireDeny = () => {
    if (buttonsLocked) return;
    p.onDeny?.();
  };

  return (
    <div
      style={box}
      data-kit-network-approval-card=""
      data-network-state={state}
      aria-busy={sending || undefined}
    >
      <div style={head}>
        <Icon icon="approval" size={14} color={accent.amber.ink} />
        <span style={titleStyle}>{heading}</span>
        <span style={{ flex: "none", display: "flex" }}>
          <Chip label={badgeText} tone="amber" variant="soft" mono={false} />
        </span>
      </div>

      {(p.target && p.target !== p.originLabel) || p.waitingLabel || p.deadlineLabel ? (
        <div style={metaRow}>
          {p.target && p.target !== p.originLabel ? (
            <span style={{ overflowWrap: "anywhere" }}>{p.target}</span>
          ) : null}
          {p.waitingLabel ? <span data-kit-waiting-time="">{p.waitingLabel}</span> : null}
          {p.deadlineLabel ? <span data-kit-deadline="">{p.deadlineLabel}</span> : null}
        </div>
      ) : null}

      {state === "updated" && p.updateNotice ? (
        <div style={noticeStyle} data-kit-update-notice="">
          <Icon icon="failed" size={12} color={accent.gold.ink} />
          <span>{p.updateNotice}</span>
        </div>
      ) : null}

      {p.description ? <p style={descStyle}>{p.description}</p> : null}

      <div style={actionsRow} data-kit-network-actions="">
        {offersOnce ? (
          <Button
            label={sending ? "Sending…" : `Allow once${p.shortcuts ? ` ${p.shortcuts.allow}` : ""}`}
            ariaLabel={sending ? `Sending approval for ${p.originLabel}` : `Allow once for ${p.originLabel}`}
            tone="primary"
            size="md"
            center
            block={false}
            disabled={sending}
            ariaDisabled={armed}
            style={allowMount}
            onClick={p.onSelectScope ? () => fireScope("once") : undefined}
          />
        ) : legacyUnscoped ? (
          <Button
            label={sending ? "Sending…" : `Allow${p.shortcuts ? ` ${p.shortcuts.allow}` : ""}`}
            ariaLabel={sending ? `Sending approval for ${p.originLabel}` : `Allow ${p.originLabel}`}
            tone="primary"
            size="md"
            center
            block={false}
            disabled={sending}
            ariaDisabled={armed}
            style={allowMount}
            onClick={p.onAllow ? fireAllow : undefined}
          />
        ) : null}
        <Button
          label={`Deny${p.shortcuts ? ` ${p.shortcuts.deny}` : ""}`}
          ariaLabel={`Deny ${p.originLabel}`}
          tone="danger"
          size="md"
          center
          block={false}
          disabled={sending}
          ariaDisabled={armed}
          style={denyMount}
          onClick={p.onDeny ? fireDeny : undefined}
        />
      </div>

      {offersOrigin || offersSession ? (
        <div style={scopeRow} data-kit-network-scope-actions="">
          {offersOrigin ? (
            <Button
              label={`Allow ${p.originLabel} for this chat`}
              ariaLabel={`Allow ${p.originLabel} for this chat`}
              tone="quiet"
              size="sm"
              center
              block={false}
              disabled={sending}
              ariaDisabled={armed}
              style={secondaryMount}
              onClick={p.onSelectScope ? () => fireScope("origin") : undefined}
            />
          ) : null}
          {offersSession ? (
            <Button
              label="Allow all sites for this chat"
              ariaLabel="Allow all sites for this chat"
              tone="quiet"
              size="sm"
              center
              block={false}
              disabled={sending}
              ariaDisabled={armed}
              style={secondaryMount}
              onClick={p.onSelectScope ? () => fireScope("session") : undefined}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
