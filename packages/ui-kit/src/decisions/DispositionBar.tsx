import type { CSSProperties } from "react";

import { Button } from "../primitives/Button.js";
import { color, font } from "../tokens.js";

/**
 * The answer row under a durable decision: one commit, then Later, then
 * Dismiss.
 *
 * The commit — Approve, or Choose's "Apply: …" — takes the remaining width,
 * and Later and Dismiss are content-sized with the 96 x 44 floor the live
 * approval card uses, so no answer becomes a sliver and no even split claims
 * the answers are equally likely. The row wraps at 320px rather than
 * shrinking a control below its floor.
 *
 * Every control can be absent (`undefined`), present, or disabled. A disabled
 * bar prints its reason once, as text under the row: a dim button with no
 * "why" teaches that the bar is broken. `busy` names the control whose answer
 * is being recorded; while set, every control is inert and the busy one reads
 * `busyLabel` ("Recording…"), because no model runs and nothing is thinking.
 */
export interface DispositionControl {
  label: string;
  /** The accessible name, naming the target: "Approve: Edit finances/…". */
  name?: string;
  /** The mono effect chip on the commit, e.g. `enqueue`. */
  effect?: string;
  disabled?: boolean;
  onClick?: () => void;
}

export interface DispositionBarProps {
  commit?: DispositionControl;
  later?: DispositionControl;
  dismiss?: DispositionControl;
  /** Which control's answer is in flight. Every control is inert meanwhile. */
  busy?: "commit" | "later" | "dismiss";
  busyLabel?: string;
  /** Why the controls that are disabled are disabled, printed once. */
  reason?: string;
}

const COMMIT_MOUNT: CSSProperties = { flex: "1 1 160px", minWidth: 0, minHeight: 44, width: "auto" };
const SIDE_MOUNT: CSSProperties = { flex: "0 0 auto", minWidth: 96, minHeight: 44, width: "auto" };

type Slot = "commit" | "later" | "dismiss";

export function DispositionBar(p: DispositionBarProps) {
  const busy = p.busy !== undefined;
  const row: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "stretch" };
  const reason: CSSProperties = { marginTop: 6, font: `500 10px/1.4 ${font.mono}`, color: color.inkMute };
  const label = (slot: Slot, control: DispositionControl) =>
    p.busy === slot ? (p.busyLabel ?? "Recording…") : control.label;
  const name = (slot: Slot, control: DispositionControl) => (p.busy === slot ? undefined : control.name);

  return (
    <div data-disposition-bar="" aria-busy={busy ? true : undefined}>
      <div style={row}>
        {p.commit ? (
          <Button
            label={label("commit", p.commit)}
            ariaLabel={name("commit", p.commit)}
            effect={p.commit.effect}
            icon="confirm"
            tone="primary"
            size="sm"
            center
            block={false}
            style={COMMIT_MOUNT}
            disabled={busy || p.commit.disabled === true}
            onClick={p.commit.onClick}
          />
        ) : null}
        {p.later ? (
          <Button
            label={label("later", p.later)}
            ariaLabel={name("later", p.later)}
            tone="ghost"
            size="sm"
            center
            block={false}
            style={SIDE_MOUNT}
            disabled={busy || p.later.disabled === true}
            onClick={p.later.onClick}
          />
        ) : null}
        {p.dismiss ? (
          <Button
            label={label("dismiss", p.dismiss)}
            ariaLabel={name("dismiss", p.dismiss)}
            tone="quiet"
            size="sm"
            center
            block={false}
            style={SIDE_MOUNT}
            disabled={busy || p.dismiss.disabled === true}
            onClick={p.dismiss.onClick}
          />
        ) : null}
      </div>
      {p.reason ? <div style={reason}>{p.reason}</div> : null}
    </div>
  );
}
