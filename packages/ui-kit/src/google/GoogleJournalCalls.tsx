import type { CSSProperties } from "react";

import { color, font } from "../tokens.js";

export interface GoogleJournalCall {
  /** Row key. */
  id: number | string;
  operation: string;
  target: string | null;
  tainted: boolean;
  decision: "allowed" | "approved" | "declined" | "refused";
  admission: "policy" | "remembered_approval" | "session_allowance" | null;
}

export interface GoogleJournalCallsProps {
  calls: readonly GoogleJournalCall[];
  /** The host kept only the first rows. */
  truncated?: boolean;
  /** Heading level. Defaults to 3, matching the journal's other sections. */
  headingLevel?: 2 | 3 | 4;
}

/** Words for a Google operation, also used by the journal's outward rows. */
export function googleOperationWords(operation: string): { text: string; mono?: string } {
  switch (operation) {
    case "gmail.modify": return { text: "Gmail label change" };
    case "gmail.draft.save": return { text: "Gmail draft save" };
    case "gmail.draft.send": return { text: "Gmail send" };
    case "gmail.draft.delete": return { text: "Gmail draft delete" };
    case "gmail.trash": return { text: "Gmail trash" };
    default: return { text: "Google call", mono: operation };
  }
}

function decisionWords(call: GoogleJournalCall): string {
  switch (call.decision) {
    case "approved": return "Approved on its card";
    case "declined": return "Declined";
    case "refused": return "Refused";
    case "allowed":
      switch (call.admission) {
        case "policy": return "Allowed by policy";
        case "remembered_approval": return "Allowed by your Google approvals";
        case "session_allowance": return "Allowed for this chat";
        default: return "Allowed";
      }
  }
}

// Match the standing lists' MONO_ID size without changing their shared paint.
const MONO: CSSProperties = { font: `500 11.5px/1.35 ${font.mono}` };
const TARGET: CSSProperties = { ...MONO, overflowWrap: "anywhere" };
const NOTE: CSSProperties = { margin: "8px 0 0", color: color.inkMute };

/** Reversible admission receipts, inheriting the surrounding journal's type. */
export function GoogleJournalCalls({ calls, truncated, headingLevel = 3 }: GoogleJournalCallsProps) {
  if (calls.length === 0) return null;
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  return (
    <section data-google-journal-calls="" style={{ minWidth: 0 }}>
      <Heading style={{ margin: 0, fontSize: "inherit", fontWeight: 500 }}>Reversible Google calls</Heading>
      <p style={{ margin: "8px 0 0" }}>These record each decision, not that Google applied it. Brain recorded how to reverse each admitted change, but restoring local files does not reverse them. Undo is not available here yet.</p>
      <ul role="list" className="grid gap-[8px] any-pointer-coarse:gap-y-[16px]" style={{ margin: "8px 0 0", padding: 0, listStyle: "none" }}>
        {calls.map((call) => {
          const words = googleOperationWords(call.operation);
          return (
            <li key={call.id}>
              <span data-google-journal-row="">
                {words.text}{words.mono !== undefined ? <> <span style={MONO} data-google-operation-id="">{words.mono}</span></> : null}
                {" · "}{decisionWords(call)}
                {call.target !== null && call.target !== call.operation ? <> · <span style={TARGET} data-google-journal-target="">{call.target}</span></> : null}
              </span>
              {call.tainted && (call.decision === "allowed" || call.decision === "approved") ? (
                <span data-google-journal-taint="" style={{ display: "block", color: color.inkMute }}>Review recommended: the chat had read text other people wrote.</span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {truncated ? <p style={NOTE}>Showing the first 1,000 reversible Google calls. More remain in the retained governance records.</p> : null}
    </section>
  );
}
