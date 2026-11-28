import { useRef, type KeyboardEvent } from "react";
import { GOOGLE_MAIL_APPROVAL_SCHEMA } from "@schlessera/brain-ui-sdk/tool-contracts";
import { googleMailApprovalProps } from "./google-mail-approval.js";
import { ApprovalCard, GoogleMailApprovalCard, googleApprovalKeys } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot } from "../../root-context.js";
import { awaitsDecision, offersAlwaysAllow, useChatStore, type ToolCall } from "../../stores/chat-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { useFinePointer } from "../../hooks/use-fine-pointer.js";
import { focusAfterDecision, singleKey } from "../../lib/single-key.js";
import { GENERIC_RENDERER, registerBuiltinRenderers } from "./renderers/index.js";
import type { ToolRenderer } from "@schlessera/brain-ui-sdk/client";
import { effectOf, getToolLabel } from "./tool-views.js";
import { riskHints } from "./risk-hints.js";
import { APIFY_APPROVAL_TOOLS, apifyApprovalTarget } from "./renderers/apify-tools.js";
import { githubApproval } from "./renderers/github-tools.js";

export function ToolPermissionCard({ toolCall, onApproval, backendId, renderer: forced }: {
  toolCall: ToolCall;
  onApproval?: (id: string, approved: boolean, always?: boolean, forSession?: boolean) => boolean | void;
  backendId?: string;
  /** Skip resolution: the timeline row's boundary caught this tool's renderer throwing. */
  renderer?: ToolRenderer;
}) {
  const root = useBrainUiRoot();
  const activeBackend = useChatStore(s => (s.activeSessionId ? s.backendIds[s.activeSessionId] : undefined) ?? "claude");
  const keys = useUIStore(s => s.singleKeyShortcuts);
  const printKeys = useFinePointer() && keys;
  const card = useRef<HTMLDivElement>(null);
  const decision = useRef({ id: toolCall.id, sent: false });
  if (decision.current.id !== toolCall.id) decision.current = { id: toolCall.id, sent: false };
  registerBuiltinRenderers(root.renderers);
  const renderer = forced ?? root.renderers.resolve(toolCall, backendId ?? activeBackend) ?? GENERIC_RENDERER;
  if (!awaitsDecision(toolCall)) return null;
  const parsed = toolCall.approvalKind === "google" ? GOOGLE_MAIL_APPROVAL_SCHEMA.safeParse(toolCall.input) : null;
  const google = parsed?.success ? parsed.data : null;
  // A Google request that fails the parse has an unknown effect: no single-key allow.
  const boundKeys = toolCall.approvalKind === "google" ? googleApprovalKeys(google?.effect ?? "irreversible") : { allow: "a", deny: "d" };
  const label = typeof renderer.label === "function" ? renderer.label(toolCall) : renderer.label ?? getToolLabel(toolCall.name);
  const Input = toolCall.approvalKind === "google" && !google ? GENERIC_RENDERER.Input : renderer.Input;
  const input = toolCall.input ?? {};
  // An Apify card names its Actor or query; its review renders below, never as one JSON line (#3163).
  const apifyRun = toolCall.name === APIFY_APPROVAL_TOOLS.run;
  // A GitHub write names its repository (and issue); its draft renders below as W1/W4 (#3795).
  const github = githubApproval(toolCall);
  const target = apifyApprovalTarget(toolCall) ?? github?.target ?? [input.command, input.cmd, input.file_path, input.notebook_path, input.path, input.url, input.target]
    .find((value): value is string => typeof value === "string" && value.length > 0)
    ?? JSON.stringify(input);
  function decide(approved: boolean, always?: boolean, forSession?: boolean) {
    if (!onApproval || decision.current.sent) return;
    decision.current.sent = true;
    const focused = document.activeElement;
    if (card.current) focusAfterDecision(card.current, "[data-approval-card]", "textarea[data-composer]");
    const accepted = forSession === undefined ? onApproval(toolCall.id, approved, always) : onApproval(toolCall.id, approved, always, forSession);
    if (accepted === false) {
      decision.current.sent = false;
      if (focused instanceof HTMLElement && focused.isConnected) focused.focus();
    }
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!keys) return;
    const key = singleKey(event);
    if (key !== boundKeys.allow && key !== boundKeys.deny) return;
    event.preventDefault(); decide(key === boundKeys.allow);
  }
  return <div ref={card} data-approval-card data-tool-use-id={toolCall.id} role="group" aria-label={`Approval: ${label}`} tabIndex={0}
    onKeyDown={onKeyDown} className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-primary/50" style={{overflowWrap:"anywhere"}}>
    {google ? <GoogleMailApprovalCard {...googleMailApprovalProps(google)} shortcuts={printKeys}
      onAllow={onApproval ? () => decide(true) : undefined} onDeny={onApproval ? () => decide(false) : undefined}
      {...(onApproval && google.effect === "reversible" && (google.tainted ? google.offers.allow_for_session : google.offers.allow_always)
        ? { onStanding: () => google.tainted ? decide(true, undefined, true) : decide(true, true) } : {})} /> : <ApprovalCard tool={toolCall.name} target={target} toolIcon="approval"
      badge={`Approval needed${apifyRun ? " · paid run" : ""}${toolCall.restored ? " · restored" : ""}`}
      {...(apifyApprovalTarget(toolCall) !== null ? { allowLabel: "Allow once" } : {})}
      {...(github ? { allowLabel: github.allowLabel, denyLabel: github.denyLabel } : {})}
      wrapHeader diff="" risk={riskHints(toolCall, renderer.semantics).join(" · ")}
      shortcuts={printKeys ? boundKeys : undefined}
      onAllow={onApproval ? () => decide(true) : undefined} onDeny={onApproval ? () => decide(false) : undefined}
      onAlwaysAllow={onApproval && offersAlwaysAllow(toolCall) ? () => decide(true, true) : undefined}>
      {Input ? <Input tool={toolCall} /> : null}
      {effectOf(toolCall) ? <p className="text-[11px] text-muted-foreground">{effectOf(toolCall)}</p> : null}
    </ApprovalCard>}
  </div>;
}
