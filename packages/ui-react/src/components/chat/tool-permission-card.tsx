import { useRef, type KeyboardEvent } from "react";
import { ApprovalCard } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot } from "../../root-context.js";
import { awaitsDecision, offersAlwaysAllow, useChatStore, type ToolCall } from "../../stores/chat-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { useFinePointer } from "../../hooks/use-fine-pointer.js";
import { focusAfterDecision, singleKey } from "../../lib/single-key.js";
import { GENERIC_RENDERER, registerBuiltinRenderers } from "./renderers/index.js";
import { effectOf, getToolLabel } from "./tool-views.js";
import { riskHints } from "./risk-hints.js";

export function ToolPermissionCard({ toolCall, onApproval, backendId }: {
  toolCall: ToolCall;
  onApproval?: (id: string, approved: boolean, always?: boolean) => boolean | void;
  backendId?: string;
}) {
  const root = useBrainUiRoot();
  const activeBackend = useChatStore(s => (s.activeSessionId ? s.backendIds[s.activeSessionId] : undefined) ?? "claude");
  const keys = useUIStore(s => s.singleKeyShortcuts);
  const printKeys = useFinePointer() && keys;
  const card = useRef<HTMLDivElement>(null);
  const decision = useRef({ id: toolCall.id, sent: false });
  if (decision.current.id !== toolCall.id) decision.current = { id: toolCall.id, sent: false };
  registerBuiltinRenderers(root.renderers);
  const renderer = root.renderers.resolve(toolCall, backendId ?? activeBackend) ?? GENERIC_RENDERER;
  if (!awaitsDecision(toolCall)) return null;
  const label = typeof renderer.label === "function" ? renderer.label(toolCall) : renderer.label ?? getToolLabel(toolCall.name);
  const Input = renderer.Input;
  const input = toolCall.input ?? {};
  const target = [input.command, input.cmd, input.file_path, input.notebook_path, input.path, input.url, input.target]
    .find((value): value is string => typeof value === "string" && value.length > 0)
    ?? JSON.stringify(input);
  function decide(approved: boolean, always?: boolean) {
    if (!onApproval || decision.current.sent) return;
    decision.current.sent = true;
    const focused = document.activeElement;
    if (card.current) focusAfterDecision(card.current, "[data-approval-card]", "textarea[data-composer]");
    if (onApproval(toolCall.id, approved, always) === false) {
      decision.current.sent = false;
      if (focused instanceof HTMLElement && focused.isConnected) focused.focus();
    }
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!keys) return;
    const key = singleKey(event);
    if (key !== "a" && key !== "d") return;
    event.preventDefault(); decide(key === "a");
  }
  return <div ref={card} data-approval-card data-tool-use-id={toolCall.id} role="group" aria-label={`Approval: ${label}`} tabIndex={0}
    onKeyDown={onKeyDown} className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-primary/50" style={{overflowWrap:"anywhere"}}>
    <ApprovalCard tool={toolCall.name} target={target} toolIcon="approval" badge={toolCall.restored ? "Approval needed · restored" : "Approval needed"}
      wrapHeader diff="" risk={riskHints(toolCall, renderer.semantics).join(" · ")}
      shortcuts={printKeys ? { allow: "a", deny: "d" } : undefined}
      onAllow={onApproval ? () => decide(true) : undefined} onDeny={onApproval ? () => decide(false) : undefined}
      onAlwaysAllow={onApproval && offersAlwaysAllow(toolCall) ? () => decide(true, true) : undefined}>
      {Input ? <Input tool={toolCall} /> : null}
      {effectOf(toolCall) ? <p className="text-[11px] text-muted-foreground">{effectOf(toolCall)}</p> : null}
    </ApprovalCard>
  </div>;
}
