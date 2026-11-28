/**
 * One-line terminal Network approval receipts kept in the transcript (#4967, #3595).
 */
import { NetworkApprovalCard, defaultNetworkOutcomeLabel } from "@schlessera/brain-ui-kit";
import { activeChat, useChatStore } from "../../stores/chat-store.js";

export function NetworkApprovalReceipts() {
  const receipts = useChatStore((s) => activeChat(s).networkReceipts);
  if (!receipts || receipts.length === 0) return null;

  return (
    <div className="space-y-1.5 py-2" data-network-approval-receipts="">
      {receipts.map((receipt) => {
        const label =
          receipt.grantedByGrant && receipt.reason
            ? receipt.reason
            : receipt.state === "granted"
              ? defaultNetworkOutcomeLabel("granted", receipt.originLabel, receipt.scope)
              : receipt.reason || defaultNetworkOutcomeLabel(receipt.state, receipt.originLabel, receipt.scope);
        return (
          <div key={receipt.id} data-network-receipt-id={receipt.toolUseId}>
            <NetworkApprovalCard
              originLabel={receipt.originLabel}
              state={receipt.state}
              grantedScope={receipt.scope}
              outcomeLabel={label}
            />
          </div>
        );
      })}
    </div>
  );
}
