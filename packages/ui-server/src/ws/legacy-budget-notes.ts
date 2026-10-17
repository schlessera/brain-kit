import type { SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";

// The exact suffix emitted in 0.42/0.43. This is a UI replay migration only:
// provider transcripts and #2047's provenance-owned new tail context stay intact.
const NUMBER = String.raw`\d+(?:\.\d+)?(?:e[+-]?\d+)?`;
const SCOPE = String.raw`(?:price unknown|\$${NUMBER} known lower bound); warn \$${NUMBER}; stop \$${NUMBER}; unpriced token stop ${NUMBER}(?:; resets \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)?(?:; WARNING threshold reached)?`;
const LEGACY_NOTE = new RegExp(String.raw`\n\n\[Host inference capabilities: Built-in inference only; provider and tool spend is not metered\. These are list-price usage limits, not subscription invoices\. turn: ${SCOPE}\. session: ${SCOPE}\. day: ${SCOPE}\. Warnings are visual only in voice posture; do not speak them\. Stops preserve partial work for review\.\](?![\s\S])`);

/** Remove the legacy host suffix before local-context and source joins. */
export function stripLegacyBudgetNotes(messages: SessionHistoryMessage[]): SessionHistoryMessage[] {
  return messages.map(message => {
    if (message.role !== "user") return message;
    const content = message.content.replace(LEGACY_NOTE, "");
    return content === message.content ? message : { ...message, content };
  });
}
