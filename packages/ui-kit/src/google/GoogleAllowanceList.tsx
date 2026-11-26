import { Fragment, useId, useRef, type CSSProperties } from "react";

import { Button } from "../primitives/Button.js";
import { Callout } from "../primitives/Callout.js";
import { Label } from "../primitives/Label.js";
import { Surface } from "../primitives/Surface.js";
import { Placeholder } from "../states/Placeholder.js";
import { accent, color, font } from "../tokens.js";
import {
  ADDRESS,
  ActionWords,
  EXPLAINER,
  HEADING,
  LIST_ROOT,
  TARGET_ATTR,
  actionText,
  joinAnd,
  titleStyle,
  useFocusAfterRemoval,
  type GoogleHostTime,
  type GoogleStandingAction,
} from "./shared.js";

/**
 * A restricted chat's Gmail allowances (#4212): what the owner allowed on a
 * card in this chat, one row per card, each with its own Revoke.
 *
 * The rows of one card share the card's change budget, so a row shows what is
 * left of it and when the allowance ends. Revoke is a visible quiet `Button`
 * with `reach`, not a whole-row tap: in a chat the row sits among other
 * controls. Under a coarse pointer it reaches 44px past its paint; the row's
 * 12px padding holds that reach inside the card.
 *
 * Ten changes left or fewer turns the count amber; the count itself says it,
 * so the colour is never the only signal. A used-up allowance says so, dims,
 * and can still be revoked. When the grants span two or more accounts, each
 * row also names its account, in its text and in its Revoke's name.
 *
 * When the host drops a revoked row, focus goes to the next row's Revoke,
 * else the previous one, else the heading.
 */
export interface GoogleAllowanceListProps {
  state: "ready" | "loading" | "unavailable";
  grants: { id: string; address: string; actions: GoogleStandingAction[]; remaining: number; limit: number; until: GoogleHostTime }[];
  /** The grant whose revoke is in flight. */
  busy?: string | null;
  /** The last revoke failure, shown as a banner under the list. */
  error?: string | null;
  onRevoke(id: string): void;
}

const HEADING_TEXT = "Allowed in this chat";
const EXPLAINER_TEXT =
  "This chat is restricted, so remembered approvals are off. You allowed these on a card here. They end at the time shown, when the chat returns to normal, when the policy changes or when Brain restarts.";
const EMPTY_TEXT = "Nothing is allowed in this chat. Each Gmail change asks.";
const UNAVAILABLE_TEXT = "Allowances for this chat can't be read right now, so each Gmail change asks until they can.";

/** At or under this many changes left, the count turns amber. */
const LOW = 10;

export function GoogleAllowanceList(p: GoogleAllowanceListProps) {
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLDivElement>(null);
  const grants = p.state === "ready" ? p.grants : [];
  const ids = grants.map((grant) => grant.id);
  const accounts = new Set(grants.map((grant) => grant.address)).size;
  const focus = useFocusAfterRemoval(ids, root, heading);

  return (
    <div ref={root} data-google-allowances={p.state} style={LIST_ROOT} onFocus={focus.onFocus} onBlur={focus.onBlur}>
      <div ref={heading} role="heading" aria-level={3} tabIndex={-1} style={HEADING}>
        <Label text={HEADING_TEXT} icon="capability" />
      </div>
      <p style={EXPLAINER}>{EXPLAINER_TEXT}</p>
      {p.state === "loading" ? <Placeholder variant="loading" lines={2} /> : null}
      {p.state === "unavailable" ? <Callout tone="amber" variant="boxed" icon="unverified" text={UNAVAILABLE_TEXT} /> : null}
      {p.state === "ready" && grants.length === 0 ? <Placeholder variant="empty" message={EMPTY_TEXT} /> : null}
      {grants.length > 0 ? (
        <Surface pad={0}>
          {grants.map((grant, i) => (
            <GrantRow
              key={grant.id}
              grant={grant}
              showAddress={accounts > 1}
              busy={p.busy === grant.id}
              last={i === grants.length - 1}
              onRevoke={p.onRevoke}
            />
          ))}
        </Surface>
      ) : null}
      {p.error ? (
        <div role="alert">
          <Callout tone="red" variant="banner" icon="failed" mono text={p.error} />
        </div>
      ) : null}
    </div>
  );
}

interface GrantRowProps {
  grant: GoogleAllowanceListProps["grants"][number];
  showAddress: boolean;
  busy: boolean;
  last: boolean;
  onRevoke(id: string): void;
}

function GrantRow({ grant, showAddress, busy, last, onRevoke }: GrantRowProps) {
  const untilId = useId();
  const used = grant.remaining <= 0;
  const low = grant.remaining <= LOW;
  const name = `Revoke ${joinAnd(grant.actions.map(actionText))}${showAddress ? ` for ${grant.address}` : ""}`;
  const meta = used
    ? `All ${grant.limit} used · each change asks again`
    : `${grant.remaining} of ${grant.limit} changes left · until ${grant.until.short}`;
  const box: CSSProperties = {
    display: "flex",
    alignItems: "flex-end",
    gap: 11,
    boxSizing: "border-box",
    width: "100%",
    padding: "12px 13px",
    borderBottom: last ? "none" : `1px solid ${color.line}`,
  };
  const metaStyle: CSSProperties = {
    display: "block",
    font: `${low ? 500 : 400} 10.5px/1.4 ${font.body}`,
    color: low ? accent.amber.ink : color.inkMute,
  };
  return (
    <div {...{ [TARGET_ATTR]: grant.id }} data-google-grant={used ? "used" : low ? "low" : "open"} data-busy={busy ? "" : undefined} style={box}>
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={titleStyle(busy || used)}>
          {grant.actions.map((action, i) => (
            <Fragment key={i}>
              {i > 0 ? " · " : null}
              <ActionWords action={action} />
            </Fragment>
          ))}
        </span>
        {showAddress ? <span style={ADDRESS}>{grant.address}</span> : null}
        <span style={metaStyle} data-google-meta="">{meta}</span>
      </span>
      <span id={untilId} hidden>until {grant.until.full}</span>
      <Button
        label={busy ? "Revoking…" : "Revoke"}
        tone="quiet"
        size="sm"
        block={false}
        reach
        ariaLabel={name}
        ariaDescribedBy={untilId}
        ariaDisabled={busy}
        onClick={() => {
          if (!busy) onRevoke(grant.id);
        }}
      />
    </div>
  );
}
