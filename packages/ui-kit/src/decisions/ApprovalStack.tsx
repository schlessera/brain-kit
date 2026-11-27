import type { CSSProperties, ReactNode } from "react";

import { Button } from "../primitives/Button.js";
import { Chip } from "../primitives/Chip.js";
import { Icon } from "../primitives/Icon.js";
import { accent, color, font, token } from "../tokens.js";

export interface ApprovalStackProps {
  /** Total pending approval requests across the open chat. */
  count: number;
  /** Number of distinct origins waiting (used for collapsed summary and "Allow all N sites"). */
  originCount: number;
  /** Collapsed mobile-keyboard mode: compact single row above composer, never covering input. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** Shown when multiple non-managed origins wait and host advertises session scope. */
  allowAllLabel?: string;
  allowAllDisabled?: boolean;
  onAllowAll?: () => void;
  /** Polite live-region announcement for in-place updates; never steals focus. */
  announcement?: string;
  /** Maximum height of the scrollable card list in CSS pixels (default 280). */
  maxBodyHeight?: number;
  children?: ReactNode;
}

/**
 * Pinned "Needs your approval" stack rendered directly above the composer
 * for the open chat only (#4967).
 *
 * Presentational only: manages no timers, keyboard hooks, or stores.
 */
export function ApprovalStack(p: ApprovalStackProps) {
  if (p.count <= 0) return null;

  const summary =
    p.originCount > 1
      ? `${p.originCount} sites · ${p.count} waiting`
      : p.count === 1
        ? "1 waiting"
        : `${p.count} waiting`;

  const shell: CSSProperties = {
    border: `1.5px solid ${token("surface-border-amber")}`,
    background: color.surface,
    borderRadius: 14,
    padding: p.collapsed ? "6px 10px" : "8px 10px",
    boxSizing: "border-box",
    width: "100%",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  };
  const header: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
    minHeight: 36,
  };
  const titleStyle: CSSProperties = {
    font: `600 12px/1.3 ${font.body}`,
    color: color.ink,
    flex: "1 1 auto",
    minWidth: 0,
  };
  const listStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    maxHeight: p.maxBodyHeight ?? 280,
    overflowY: "auto",
  };
  const srOnly: CSSProperties = {
    position: "absolute",
    width: 1,
    height: 1,
    padding: 0,
    margin: -1,
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    whiteSpace: "nowrap",
    border: 0,
  };

  return (
    <section
      style={shell}
      data-kit-approval-stack=""
      data-collapsed={p.collapsed ? "true" : "false"}
      aria-label="Needs your approval"
    >
      <div aria-live="polite" aria-atomic="true" style={srOnly} data-kit-approval-announcement="">
        {p.announcement ?? ""}
      </div>

      <div style={header}>
        <Icon icon="approval" size={14} color={accent.amber.ink} />
        <span style={titleStyle}>Needs your approval</span>
        <Chip label={summary} tone="amber" variant="soft" mono={false} />
        {p.onToggleCollapsed ? (
          <Button
            label={p.collapsed ? "Show" : "Hide"}
            ariaLabel={p.collapsed ? "Show pending approvals" : "Collapse pending approvals"}
            tone="quiet"
            size="sm"
            block={false}
            style={{ minHeight: 44, minWidth: 64 }}
            onClick={p.onToggleCollapsed}
          />
        ) : null}
      </div>

      {!p.collapsed && p.allowAllLabel && p.onAllowAll ? (
        <Button
          label={p.allowAllLabel}
          ariaLabel={p.allowAllLabel}
          tone="suggest"
          size="sm"
          center
          disabled={p.allowAllDisabled}
          style={{ minHeight: 44 }}
          onClick={p.onAllowAll}
        />
      ) : null}

      {!p.collapsed ? (
        <div style={listStyle} data-kit-approval-stack-body="">
          {p.children}
        </div>
      ) : null}
    </section>
  );
}
