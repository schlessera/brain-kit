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
 * the answers are equally likely.
 *
 * When the three do not fit on one line, the commit takes the first row whole
 * and Later and Dismiss share the second, side by side at equal width. They
 * wrap as a pair: a row that wrapped each control on its own left Dismiss
 * alone under the commit at every phone width (#3750), because 160 + 96 + 96
 * plus two gaps is wider than the 360px column. The commit's basis is its own
 * label, so a long "Apply: …" moves to its own row before it breaks a line.
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

// The commit's grow dwarfs the pair's, so on one line it takes the slack; on
// a line of its own the pair takes all of it. `min()` keeps the 160px floor
// from overflowing a container narrower than the floor itself.
const COMMIT_MOUNT: CSSProperties = { flex: "999 1 auto", minWidth: "min(160px, 100%)", minHeight: 44, width: "auto" };
const SIDES: CSSProperties = { display: "flex", flex: "1 1 auto", gap: 8, minWidth: 0 };
const SIDE_MOUNT: CSSProperties = { flex: "1 0 96px", minWidth: 96, minHeight: 44, width: "auto" };

type Slot = "commit" | "later" | "dismiss";

export function DispositionBar(p: DispositionBarProps) {
  const busy = p.busy !== undefined;
  const row: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "stretch" };
  const reason: CSSProperties = { marginTop: 6, font: `500 10px/1.4 ${font.mono}`, color: color.inkMute };
  const label = (slot: Slot, control: DispositionControl) =>
    p.busy === slot ? (p.busyLabel ?? "Recording…") : control.label;
  const name = (slot: Slot, control: DispositionControl) => (p.busy === slot ? undefined : control.name);

  return (
    <div data-disposition-bar="" aria-busy={busy ? true : undefined} style={{ width: "100%" }}>
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
        {p.later || p.dismiss ? (
          <div style={SIDES}>
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
        ) : null}
      </div>
      {p.reason ? <div style={reason}>{p.reason}</div> : null}
    </div>
  );
}
