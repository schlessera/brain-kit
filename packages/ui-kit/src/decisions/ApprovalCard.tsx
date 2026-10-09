import type { CSSProperties, ReactNode } from "react";

import { Button } from "../primitives/Button.js";
import { Chip } from "../primitives/Chip.js";
import { DiffBlock } from "../primitives/DiffBlock.js";
import { Icon, type IconName } from "../primitives/Icon.js";
import { accent, color, font, token } from "../tokens.js";

/**
 * Confirm-before-action, inline in the transcript.
 *
 * Amber means the agent is asking permission. It always shows the real tool,
 * the real target and the real diff, and the risk line states the blast radius
 * in plain words. **Never use this for anything that is not actually
 * blocking** — the design is explicit, and a card that asks for permission it
 * does not need teaches people to tap through the ones that matter.
 *
 * The shell is `Surface`'s `bold` emphasis in amber, to the value: a 2px 40%
 * border over a 5% tint. It reads those tokens rather than minting its own,
 * because "needs a decision" is one thing in this kit and not two.
 *
 * `allowEffect` is not decoration. The design's non-negotiable rule: a control
 * that writes exposes its effect chip as part of its accessible name —
 * "Fetch once, enqueue" — which is what `Button`'s `effect` renders.
 *
 * No interaction states on the card itself: the card is not pressable, the two
 * buttons inside it are, and each brings wave 1's.
 *
 * THE BUTTONS ARE CONTENT-SIZED, WITH A FLOOR, and they have to be told to.
 * `Button` defaults to `block`, which is `width: 100%` plus `flex: none` —
 * full width, and refuses to shrink — so two of them in a flex row each
 * demand the whole row and the second overflows the card. The `style` prop
 * exists for exactly this.
 *
 * This card shipped with that bug, and the reason it was invisible is the
 * `sc-host` decision rather than anything about Buttons. Under the DC runtime
 * the flex items were the wrapper divs and each Button was a block child
 * INSIDE one, so `width: 100%` resolved against a shrink-to-fit box and came
 * out content-sized — measured at 155px and 65px, in a row that did not
 * overflow. Dropping the wrapper made `width: 100%` live for the first time.
 *
 * The port first answered with an even `flex: 1 1 0` split, reading the two
 * 50% hints as the only statement of intent and calling the content-sized
 * render an accident of the wrapper. The seventh drop ruled the other way
 * (ruling 10): "the component is right and the 50/50 drawing was wrong. An
 * even split claims the two answers are equally likely, which the card has no
 * business claiming — the agent asked because it expects yes." So Allow
 * takes the remaining width (`flex: 1 1 auto`), Deny is content-sized
 * (`flex: 0 0 auto`) with a **96 x 44 floor** so it can never become a
 * sliver, and the head aligns `flex-start` because the target WRAPS: the
 * card IS the record — you are granting permission against this exact
 * string — and a first-ever fetch to a host cut at "…/space…" is the one
 * string here that must be readable in full. The README's truncation table
 * lists it beside the receipts.
 */
export interface ApprovalCardProps {
  /** The real tool name. */
  tool?: string;
  /** The real target: a path, a host, an identifier. */
  target?: string;
  toolIcon?: IconName;
  badge?: string;
  /** The real diff, rendered inset. */
  diff?: string;
  /** The blast radius, in plain words. */
  risk?: string;
  allowLabel?: string;
  denyLabel?: string;
  /** The effect chip on the allow button. */
  allowEffect?: string;
  onAllow?: () => void;
  onDeny?: () => void;
  /** Offered only when the host says this request can create a remembered grant. */
  onAlwaysAllow?: () => void;
  /** Real renderer input or other permission details, without demo content. */
  children?: ReactNode;
  /** Let full runtime tool names and targets occupy separate header lines. */
  wrapHeader?: boolean;
  /** Printed keys are hints; they do not change the decision's accessible name. */
  shortcuts?: { allow: string; deny: string };
}

export function ApprovalCard(p: ApprovalCardProps) {
  const box: CSSProperties = {
    border: `2px solid ${token("surface-border-amber")}`,
    background: token("surface-tint-amber"),
    borderRadius: 14,
    padding: 12,
    boxSizing: "border-box",
    width: "100%",
  };
  const head: CSSProperties = {
    display: "flex",
    alignItems: "flex-start",
    gap: 7,
    font: `500 11.5px/1.3 ${font.mono}`,
    color: color.ink,
    flexWrap: p.wrapHeader ? "wrap" : undefined,
  };
  const toolStyle: CSSProperties = { flex: p.wrapHeader ? "0 1 auto" : "none", minWidth: 0, overflowWrap: "anywhere", fontWeight: 600 };
  const targetStyle: CSSProperties = {
    flex: p.wrapHeader ? "1 1 140px" : 1,
    minWidth: 0,
    color: color.inkMute,
    fontWeight: 400,
    whiteSpace: "normal",
    overflowWrap: "anywhere",
  };
  const badgeWrap: CSSProperties = { flex: "none", display: "flex" };
  const diffWrap: CSSProperties = { margin: "9px 0 8px" };
  const riskRow: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginBottom: 9,
    font: `400 10.5px/1.5 ${font.mono}`,
    color: accent.gold.ink,
  };
  const actions: CSSProperties = { display: "flex", gap: 8 };
  /** Allow takes the remaining width; Deny is content-sized with the floor.
   * `width: auto` because `Button`'s block default would otherwise claim the
   * whole row. The row's default `align-items: stretch` gives Allow Deny's
   * height, so the floor levels both. */
  const allowMount: CSSProperties = { flex: "1 1 auto", minWidth: 0, width: "auto" };
  const denyMount: CSSProperties = { flex: "0 0 auto", minWidth: 96, minHeight: 44, width: "auto" };

  const diff = p.diff ?? "- seats: 40\n+ seats: 24\n- format: talk (45 min)\n+ format: workshop (90 min)";
  const risk = p.risk ?? "overwrites a field referenced by 2 other docs";

  return (
    <div style={box} data-kit-approval-card>
      <div style={head}>
        <Icon icon={p.toolIcon || "edit"} size={14} color={accent.amber.ink} />
        <span style={toolStyle}>{p.tool ?? "Edit"}</span>
        <span style={targetStyle}>{p.target ?? "talks/lisbon-2026.md"}</span>
        <span style={badgeWrap}>
          <Chip label={p.badge || "Approval needed"} tone="amber" variant="soft" mono={false} />
        </span>
      </div>
      {diff ? (
        <div style={diffWrap}>
          <DiffBlock text={diff} variant="inset" />
        </div>
      ) : null}
      {p.children}
      {risk ? (
        <div style={riskRow}>
          <Icon icon="failed" size={12} color={accent.gold.ink} />
          {risk}
        </div>
      ) : null}
      <div style={actions} data-kit-approval-actions>
        <Button
          label={`${p.allowLabel || "Allow"}${p.shortcuts ? ` ${p.shortcuts.allow}` : ""}`}
          ariaLabel={p.shortcuts ? [p.allowLabel || "Allow", p.allowEffect].filter(Boolean).join(", ") : undefined}
          tone="primary"
          size="md"
          center
          effect={p.allowEffect}
          style={allowMount}
          onClick={p.onAllow}
        />
        <Button label={`${p.denyLabel || "Deny"}${p.shortcuts ? ` ${p.shortcuts.deny}` : ""}`} ariaLabel={p.shortcuts ? p.denyLabel || "Deny" : undefined} tone="danger" size="md" center style={denyMount} onClick={p.onDeny} />
      </div>
      {p.onAlwaysAllow ? <Button label="Always allow" effect="write_policy" tone="quiet" size="md" center
        style={{ marginTop: 8, minHeight: 44 }} onClick={p.onAlwaysAllow} /> : null}
    </div>
  );
}
