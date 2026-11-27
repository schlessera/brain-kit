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
  FailedRead,
  HEADING,
  LIST_ROOT,
  TARGET_ATTR,
  UnshownNotice,
  actionText,
  counted,
  joinAnd,
  titleStyle,
  unshownCount,
  useFocusAfterRemoval,
  useFocusAfterRetry,
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
 * row also names its account, in its text and in its Revoke's name. The
 * rows are a real list, one item per card.
 *
 * With no row to draw (loading, empty, unavailable, failed, or only
 * allowances the host cannot name) the explainer keeps only its first
 * sentence: the rest describes rows that are not there.
 *
 * `failed` is a read that finished without a list: it says so and claims
 * neither that nothing is allowed nor that anything is still loading, with
 * Try again when the host passes `onRetry`. `unshown` counts allowances the
 * host holds but cannot name; while it is above zero the list never says
 * "Nothing is allowed", and a notice under the rows says how many and that
 * they still apply.
 *
 * When the host drops a revoked row, focus goes to the next row's Revoke,
 * else the previous one, else the heading.
 */
export interface GoogleAllowanceListProps {
  state: "ready" | "loading" | "unavailable" | "failed";
  grants: { id: string; address: string; actions: GoogleStandingAction[]; remaining: number; limit: number; until: GoogleHostTime }[];
  /** Ready only: allowances that exist in this chat but cannot be shown here. */
  unshown?: number;
  /** The grant whose revoke is in flight. */
  busy?: string | null;
  /** The last revoke failure, shown as a banner under the list. */
  error?: string | null;
  onRevoke(id: string): void;
  /** Failed only: read again. Without it the failed state offers no Try again. */
  onRetry?: () => void;
}

const HEADING_TEXT = "Allowed in this chat";
const EXPLAINER_LEAD = "This chat is restricted, so remembered approvals are off.";
const EXPLAINER_TEXT = `${EXPLAINER_LEAD} You allowed these on a card here. They end at the time shown, when the chat returns to normal, when the policy changes or when Brain restarts.`;
const EMPTY_TEXT = "Nothing is allowed in this chat. Each Gmail change asks.";
const UNAVAILABLE_TEXT = "Allowances for this chat can't be read right now, so each Gmail change asks until they can.";
const FAILED_TEXT = "Couldn't load this chat's allowances.";
const FAILED_DETAIL = "Any you allowed here may still apply.";

/** At or under this many changes left, the count turns amber. */
const LOW = 10;

export function GoogleAllowanceList(p: GoogleAllowanceListProps) {
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLDivElement>(null);
  const grants = p.state === "ready" ? p.grants : [];
  const ids = grants.map((grant) => grant.id);
  const accounts = new Set(grants.map((grant) => grant.address)).size;
  const unshown = unshownCount(p.state, p.unshown);
  const focus = useFocusAfterRemoval(ids, root, heading);
  const retry = useFocusAfterRetry(p.state, root, heading, p.onRetry);

  return (
    <div ref={root} data-google-allowances={p.state} style={LIST_ROOT} onFocus={focus.onFocus} onBlur={focus.onBlur}>
      <div ref={heading} role="heading" aria-level={3} tabIndex={-1} style={HEADING}>
        <Label text={HEADING_TEXT} icon="capability" />
      </div>
      <p style={EXPLAINER}>{grants.length > 0 ? EXPLAINER_TEXT : EXPLAINER_LEAD}</p>
      {p.state === "loading" ? <Placeholder variant="loading" lines={2} /> : null}
      {p.state === "unavailable" ? <Callout tone="amber" variant="boxed" icon="unverified" text={UNAVAILABLE_TEXT} /> : null}
      {p.state === "failed" ? <FailedRead message={FAILED_TEXT} detail={FAILED_DETAIL} onRetry={retry} /> : null}
      {p.state === "ready" && grants.length === 0 && unshown === 0 ? <Placeholder variant="empty" message={EMPTY_TEXT} /> : null}
      {grants.length > 0 ? (
        <Surface pad={0}>
          {/* `role="list"` restates the list a `list-style: none` can strip in WebKit. */}
          <ul className="bk-google-list" role="list">
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
          </ul>
        </Surface>
      ) : null}
      {unshown > 0 ? (
        <UnshownNotice count={unshown}>
          {counted(unshown, "allowance", "allowances")} in this chat can't be shown here. {unshown === 1 ? "It still applies." : "They still apply."}
        </UnshownNotice>
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
    <li {...{ [TARGET_ATTR]: grant.id }} data-google-grant={used ? "used" : low ? "low" : "open"} data-busy={busy ? "" : undefined} style={box}>
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={titleStyle(busy || used)} data-google-title="">
          {grant.actions.map((action, i) => (
            <Fragment key={i}>
              {i > 0 ? " · " : null}
              <ActionWords action={action} />
            </Fragment>
          ))}
        </span>
        {showAddress ? <span style={ADDRESS} data-google-address="">{grant.address}</span> : null}
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
    </li>
  );
}
