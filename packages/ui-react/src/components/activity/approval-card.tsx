import { ActionCard, Button } from "@schlessera/brain-ui-kit";
import type { KeyboardEvent } from "react";
import type { ClientMessage, NetworkApprovalScope } from "@schlessera/brain-ui-sdk/protocol";
import { offersAlwaysAllow, type ToolCall } from "../../stores/chat-store.js";
import { formatNetworkOriginLabel } from "../../stores/chat-slices/approvals.js";
import { focusAfterDecision, singleKey } from "../../lib/single-key.js";
import { effectOf, getToolLabel, getToolSummary } from "../chat/tool-views.js";
import { KeyCap } from "../layout/key-cap.js";
import { useFinePointer } from "../../hooks/use-fine-pointer.js";

/**
 * A pending tool approval as an Actions-pane card (D37): the transcript copy
 * and this row are the same item in two places, and deciding either
 * resolves both. The kit `ActionCard kind="approval"` carries the bold
 * border that says "a run is stopped on this"; the buttons are the same
 * three the transcript draws, with the same keys — `a` / `d` while the card
 * holds focus, printed on the buttons, and "Always allow" deliberately
 * without one, carrying its `write_policy` effect chip instead. The hint
 * is printed only while a fine pointer is present (#86); the letters follow
 * `keys` alone, so a paired keyboard works even if the pointer query stays coarse.
 *
 * The buttons follow the kit `ApprovalCard`'s rule (seventh drop, ruling 10):
 * Allow takes the remaining width, Deny is content-sized with a 96 x 44 floor
 * so it can never become a sliver, and no even split claims the two answers
 * are equally likely. The title — the tool and its target — is the kit
 * `ActionCard`'s, which wraps; the target is the record and never truncates.
 */
const ALLOW_MOUNT = { flex: "1 1 auto", minWidth: 0, width: "auto" } as const;
const DENY_MOUNT = { flex: "0 0 auto", minWidth: 96, minHeight: 44, width: "auto" } as const;
interface ApprovalCardProps {
  tool: ToolCall;
  /** Where it came from, for the foot line. */
  origin: string;
  keys: boolean;
  onDecide: (approved: boolean, always?: boolean, networkScope?: NetworkApprovalScope) => void;
}

const APPROVAL_CARD = "[data-approval-card]";

/**
 * What a decision on an Actions card prints and sends. The receipt follows
 * what the card was allowed to offer, not the click (#147, #3595): "Always
 * allowed" claims a policy write, and unadvertised network scopes are neither
 * printed nor sent. A card no longer in the list (`tool` undefined) offered nothing.
 */
export function approvalOutcome(
  tool: ToolCall | undefined,
  toolUseId: string,
  approved: boolean,
  asked?: boolean,
  requestedScope?: NetworkApprovalScope
): {
  receipt: { text: string; target: string; effect: string };
  frame: Extract<ClientMessage, { type: "tool_approval" | "tool_denial" }>;
} {
  const always = approved && asked === true && tool !== undefined && offersAlwaysAllow(tool);
  const advertisedScopes = tool?.approvalNetwork?.scopes;
  const networkScope =
    approved && requestedScope && advertisedScopes?.includes(requestedScope)
      ? requestedScope
      : undefined;
  const revision = tool?.approvalRevision;
  const targetName = tool?.approvalNetwork
    ? formatNetworkOriginLabel(tool.approvalOrigin, tool.approvalNetwork, tool.input)
    : tool
      ? tool.name
      : toolUseId;
  const text = !approved
    ? "Denied"
    : networkScope === "once"
      ? "Allowed once"
      : networkScope === "origin"
        ? `Allowed · ${targetName} · this chat`
        : networkScope === "session"
          ? "Allowed · all sites · this chat"
          : always
            ? "Always allowed"
            : "Allowed";
  return {
    receipt: {
      text,
      target: targetName,
      effect: always
        ? "write_policy"
        : networkScope
          ? `network_${networkScope}`
          : approved
            ? "tool_approval"
            : "tool_denial",
    },
    // Every decision on this surface is made on the card (#113, #4966, #3595).
    frame: approved
      ? {
          type: "tool_approval",
          toolUseId,
          ...(always ? { always: true } : {}),
          ...(revision ? { revision } : {}),
          ...(networkScope ? { networkScope } : {}),
          ...(tool?.approvalTurnId ? { turnId: tool.approvalTurnId } : {}),
          channel: "card",
        }
      : {
          type: "tool_denial",
          toolUseId,
          message: "Denied by user",
          ...(revision ? { revision } : {}),
          ...(tool?.approvalTurnId ? { turnId: tool.approvalTurnId } : {}),
          channel: "card",
        },
  };
}

export function ApprovalCard(p: ApprovalCardProps) {
  const label = getToolLabel(p.tool.name);
  const summary = getToolSummary(p.tool);
  const finePointer = useFinePointer();
  const printKeys = p.keys && finePointer;
  const networkOffer = p.tool.approvalNetwork;
  const networkScopes: readonly NetworkApprovalScope[] | undefined = networkOffer
    ? networkOffer.managedReference
      ? ["once"]
      : networkOffer.scopes
    : undefined;
  const networkLabel = networkOffer
    ? formatNetworkOriginLabel(p.tool.approvalOrigin, networkOffer, p.tool.input)
    : undefined;
  const sending = p.tool.approvalSending === true;
  function decide(card: HTMLElement | null, approved: boolean, always?: boolean, networkScope?: NetworkApprovalScope) {
    if (sending) return;
    if (card) focusAfterDecision(card, APPROVAL_CARD, "[data-needs-you-heading]");
    p.onDecide(approved, always, networkScope);
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!p.keys || sending) return;
    const key = singleKey(event);
    if (key !== "a" && key !== "d") return;
    event.preventDefault();
    if (key === "a") {
      // Keyboard shortcut `a` stays the narrowest advertised choice: once < origin < session (#3595).
      const narrowest: NetworkApprovalScope | undefined = networkScopes?.includes("once")
        ? "once"
        : networkScopes?.includes("origin")
          ? "origin"
          : networkScopes?.includes("session")
            ? "session"
            : undefined;
      decide(event.currentTarget, true, undefined, narrowest);
    } else {
      decide(event.currentTarget, false);
    }
  }
  return (
    <div data-approval-card="" role="group" aria-label={`Approval: ${label}`} tabIndex={0} onKeyDown={onKeyDown} className="rounded-[14px] outline-none focus-visible:ring-2 focus-visible:ring-primary/50">
      <ActionCard
        kind="approval"
        kindLabel={sending ? "Sending…" : "Live approval"}
        title={networkLabel ? `Network · ${networkLabel}` : summary ? `${label} · ${summary}` : label}
        rightMeta={sending ? "waiting on host" : "blocks a run"}
        rightMetaTone={sending ? "neutral" : "red"}
        {...(effectOf(p.tool) ? { body: effectOf(p.tool) } : {})}
        footMeta={p.origin}
        footDot="amber"
        footPulse={!sending}
        chevron={false}
      >
        <div className="mt-2 flex flex-wrap gap-2">
          {networkScopes ? (
            <>
              {networkScopes.includes("once") && (
                <Button
                  label={sending ? "Sending…" : "Allow once"}
                  icon="confirm"
                  tone="primary"
                  size="sm"
                  center
                  block={false}
                  disabled={sending}
                  style={{ ...ALLOW_MOUNT, minHeight: 44 }}
                  onClick={() => decide(cardOf(), true, undefined, "once")}
                />
              )}
              {!networkOffer?.managedReference && networkScopes.includes("origin") && (
                <Button
                  label={`Allow ${networkLabel} for this chat`}
                  tone="quiet"
                  size="sm"
                  block={false}
                  disabled={sending}
                  style={{ minHeight: 44, maxWidth: "100%", whiteSpace: "normal", overflowWrap: "anywhere", textAlign: "left" }}
                  onClick={() => decide(cardOf(), true, undefined, "origin")}
                />
              )}
              {!networkOffer?.managedReference && networkScopes.includes("session") && (
                <Button
                  label="Allow all sites for this chat"
                  tone="quiet"
                  size="sm"
                  block={false}
                  disabled={sending}
                  style={{ minHeight: 44 }}
                  onClick={() => decide(cardOf(), true, undefined, "session")}
                />
              )}
              <Button
                label="Deny"
                icon="deny"
                tone="danger"
                size="sm"
                center
                block={false}
                disabled={sending}
                style={DENY_MOUNT}
                onClick={() => decide(cardOf(), false)}
              />
            </>
          ) : (
            <>
              <Button label="Allow" icon="confirm" tone="primary" size="sm" center block={false} style={ALLOW_MOUNT} onClick={() => decide(cardOf(), true)} />
              {offersAlwaysAllow(p.tool) && (
                <Button label="Always allow" effect="write_policy" tone="ghost" size="sm" block={false} onClick={() => decide(cardOf(), true, true)} />
              )}
              <Button label="Deny" icon="deny" tone="danger" size="sm" center block={false} style={DENY_MOUNT} onClick={() => decide(cardOf(), false)} />
            </>
          )}
          {printKeys && (
            <span className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground" aria-hidden="true">
              <span>{networkScopes ? "allow once" : "allow"} <KeyCap>a</KeyCap></span>
              <span>deny <KeyCap>d</KeyCap></span>
            </span>
          )}
        </div>
      </ActionCard>
    </div>
  );
  function cardOf(): HTMLElement | null {
    return (document.activeElement as HTMLElement | null)?.closest(APPROVAL_CARD) ?? null;
  }
}
