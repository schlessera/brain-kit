import { useId, useRef, type CSSProperties, type KeyboardEvent } from "react";

import { Button } from "../primitives/Button.js";
import { Callout } from "../primitives/Callout.js";
import { Icon } from "../primitives/Icon.js";
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
  titleStyle,
  useFocusAfterRemoval,
  type GoogleHostTime,
  type GoogleStandingAction,
} from "./shared.js";

/**
 * Remembered Gmail approvals, for Settings (#4212): what the owner chose
 * "Allow always" for on an approval card, grouped by account, each with a
 * Revoke.
 *
 * The layout is the always-allowed tools list's (`Label`, an explainer, a
 * `Surface pad=0` of grouped rows whose trailing "Revoke" is decorative: the
 * row carries the handler and dims while its revoke is in flight). The rows are
 * drawn here rather than by `ListRow`, whose title is one truncating string
 * with no description: an approval's title can hold a label name that must
 * wrap anywhere inside `<bdi>`, or a withheld name's id in mono, and its
 * "since" line has the host's full time as its accessible description. The
 * skin, the `.bk-row` states and the keys are `ListRow`'s.
 *
 * A busy row stays focusable and announces itself as disabled, so a keyboard
 * user who pressed Enter is not dropped while the revoke runs. When the host
 * then drops the row, focus goes to the next row, else the previous one, else
 * the heading.
 *
 * Every account group shows its address, even when there is only one, so the
 * list reads the same at one account and at two. Each group is a named group
 * (its name is its address) holding a real list, one item per approval, so a
 * screen reader hears the account and the count. An account with no
 * approvals draws no group.
 */
export interface GoogleApprovalListProps {
  state: "ready" | "loading" | "unavailable";
  accounts: { address: string; approvals: { id: string; action: GoogleStandingAction; since: GoogleHostTime }[] }[];
  /** The approval whose revoke is in flight. */
  busy?: string | null;
  /** The last revoke failure, shown as a banner under the list. */
  error?: string | null;
  onRevoke(id: string): void;
}

const HEADING_TEXT = "Remembered Gmail approvals";
const EXPLAINER_TEXT =
  "These run without asking while a chat is normal. In a restricted chat every change asks again. Sending, trashing and deleting always ask. Revoke one to be asked again.";
const EMPTY_TEXT = "None yet. Every Gmail change asks first. Choose “Allow always” on a card to remember one.";
const UNAVAILABLE_TEXT = "Remembered approvals can't be read right now, so every Gmail change asks until they can.";

const SUB: CSSProperties = { display: "block", font: `400 10.5px/1.4 ${font.body}`, color: color.inkMute };

export function GoogleApprovalList(p: GoogleApprovalListProps) {
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLDivElement>(null);
  const groups = p.state === "ready" ? p.accounts.filter((account) => account.approvals.length > 0) : [];
  const ids = groups.flatMap((account) => account.approvals.map((approval) => approval.id));
  const focus = useFocusAfterRemoval(ids, root, heading);

  return (
    <div ref={root} data-google-approvals={p.state} style={LIST_ROOT} onFocus={focus.onFocus} onBlur={focus.onBlur}>
      <div ref={heading} role="heading" aria-level={3} tabIndex={-1} style={HEADING}>
        <Label text={HEADING_TEXT} icon="capability" />
      </div>
      <p style={EXPLAINER}>{EXPLAINER_TEXT}</p>
      {p.state === "loading" ? <Placeholder variant="loading" lines={2} /> : null}
      {p.state === "unavailable" ? <Callout tone="amber" variant="boxed" icon="unverified" text={UNAVAILABLE_TEXT} /> : null}
      {p.state === "ready" && groups.length === 0 ? <Placeholder variant="empty" message={EMPTY_TEXT} /> : null}
      {groups.length > 0 ? (
        <div className="bk-google-rows" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {groups.map((account) => (
            <AccountGroup key={account.address} account={account} busy={p.busy ?? null} onRevoke={p.onRevoke} />
          ))}
        </div>
      ) : null}
      {p.error ? (
        <div role="alert">
          <Callout tone="red" variant="banner" icon="failed" mono text={p.error} />
        </div>
      ) : null}
    </div>
  );
}

interface AccountGroupProps {
  account: GoogleApprovalListProps["accounts"][number];
  busy: string | null;
  onRevoke(id: string): void;
}

function AccountGroup({ account, busy, onRevoke }: AccountGroupProps) {
  const addressId = useId();
  return (
    <div role="group" aria-labelledby={addressId} data-google-account="" style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <span id={addressId} style={ADDRESS} data-google-address="">{account.address}</span>
      <Surface pad={0}>
        {/* `role="list"` restates the list a `list-style: none` can strip in WebKit. */}
        <ul className="bk-google-list" role="list">
          {account.approvals.map((approval, i) => (
            <li key={approval.id}>
              <ApprovalRow
                id={approval.id}
                action={approval.action}
                since={approval.since}
                address={account.address}
                busy={busy === approval.id}
                last={i === account.approvals.length - 1}
                onRevoke={onRevoke}
              />
            </li>
          ))}
        </ul>
      </Surface>
    </div>
  );
}

interface ApprovalRowProps {
  id: string;
  action: GoogleStandingAction;
  since: GoogleHostTime;
  address: string;
  busy: boolean;
  last: boolean;
  onRevoke(id: string): void;
}

function ApprovalRow(p: ApprovalRowProps) {
  const sinceId = useId();
  const revoke = () => {
    if (!p.busy) p.onRevoke(p.id);
  };
  // Enter and Space, as every role="button" in the kit takes both.
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    revoke();
  }
  const box = {
    boxSizing: "border-box",
    width: "100%",
    padding: "12px 13px",
    borderBottom: p.last ? "none" : `1px solid ${color.line}`,
    cursor: p.busy ? "default" : "pointer",
    "--hv-bg": color.raised,
  } as CSSProperties;
  return (
    <div
      {...{ [TARGET_ATTR]: p.id }}
      className="bk-row bk-google-row"
      role="button"
      tabIndex={0}
      aria-label={`Revoke ${actionText(p.action)} for ${p.address}`}
      aria-describedby={sinceId}
      aria-disabled={p.busy ? true : undefined}
      data-busy={p.busy ? "" : undefined}
      style={box}
      onClick={revoke}
      onKeyDown={onKeyDown}
    >
      <span className="bk-google-row-icon">
        <Icon icon="capability" size={17} color={accent.amber.ink} />
      </span>
      <span className="bk-google-row-title" style={titleStyle(p.busy)} data-google-title="">
        <ActionWords action={p.action} />
      </span>
      <span className="bk-google-row-since" style={SUB}>since {p.since.short}</span>
      <span id={sinceId} hidden>since {p.since.full}</span>
      <span className="bk-google-row-action">
        <Button label={p.busy ? "Revoking…" : "Revoke"} tone="ghost" size="sm" block={false} />
      </span>
    </div>
  );
}
