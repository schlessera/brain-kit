import { ActionCard, Button } from "@schlessera/brain-ui-kit";
import type { KeyboardEvent } from "react";
import type { ToolCall } from "../../stores/chat-store.js";
import { focusAfterDecision, singleKey } from "../../lib/single-key.js";
import { getToolLabel, getToolSummary } from "../chat/tool-views.js";
import { KeyCap } from "../layout/key-cap.js";

/**
 * A pending tool approval as an Actions-pane card (D37): the transcript copy
 * and this row are the same item in two places, and deciding either
 * resolves both. The kit `ActionCard kind="approval"` carries the bold
 * border that says "a run is stopped on this"; the buttons are the same
 * three the transcript draws, with the same keys — `a` / `d` while the card
 * holds focus, printed on the buttons, and "Always allow" deliberately
 * without one, carrying its `write_policy` effect chip instead.
 *
 * The buttons follow the kit `ApprovalCard`'s rule (seventh drop, ruling 10):
 * Allow takes the remaining width, Deny is content-sized with a 96 x 44 floor
 * so it can never become a sliver, and no even split claims the two answers
 * are equally likely. The title — the tool and its target — is the kit
 * `ActionCard`'s, which wraps; the target is the record and never truncates.
 */
const ALLOW_MOUNT = { flex: "1 1 auto", minWidth: 0, width: "auto" } as const;
const DENY_MOUNT = { flex: "0 0 auto", minWidth: 96, minHeight: 44, width: "auto" } as const;
export interface ApprovalCardProps {
  tool: ToolCall;
  /** Where it came from, for the foot line. */
  origin: string;
  keys: boolean;
  onDecide: (approved: boolean, always?: boolean) => void;
}

export const APPROVAL_CARD = "[data-approval-card]";

export function ApprovalCard(p: ApprovalCardProps) {
  const label = getToolLabel(p.tool.name);
  const summary = getToolSummary(p.tool);
  function decide(card: HTMLElement | null, approved: boolean, always?: boolean) {
    if (card) focusAfterDecision(card, APPROVAL_CARD, "[data-needs-you-heading]");
    p.onDecide(approved, always);
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!p.keys) return;
    const key = singleKey(event);
    if (key !== "a" && key !== "d") return;
    event.preventDefault();
    decide(event.currentTarget, key === "a");
  }
  return (
    <div data-approval-card="" role="group" aria-label={`Approval: ${label}`} tabIndex={0} onKeyDown={onKeyDown} className="rounded-[14px] outline-none focus-visible:ring-2 focus-visible:ring-primary/50">
      <ActionCard
        kind="approval"
        title={summary ? `${label} · ${summary}` : label}
        rightMeta="blocks a run"
        rightMetaTone="red"
        footMeta={p.origin}
        footDot="amber"
        footPulse
        chevron={false}
      >
        <div className="mt-2 flex flex-wrap gap-2">
          <Button label="Allow" icon="confirm" tone="primary" size="sm" center block={false} style={ALLOW_MOUNT} onClick={() => decide(cardOf(), true)} />
          {p.tool.approvalKind !== "command" && (
            <Button label="Always allow" effect="write_policy" tone="ghost" size="sm" block={false} onClick={() => decide(cardOf(), true, true)} />
          )}
          <Button label="Deny" icon="deny" tone="danger" size="sm" center block={false} style={DENY_MOUNT} onClick={() => decide(cardOf(), false)} />
          {p.keys && (
            <span className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground" aria-hidden="true">
              <span>allow <KeyCap>a</KeyCap></span>
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
