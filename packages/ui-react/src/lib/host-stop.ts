/**
 * What the conversation says when the host itself stopped a turn (#4565):
 * neither the user's cancel nor the turn's time limit. The runtime's own
 * text for a tool it cut short reads as the user refusing that tool, so a
 * stopped tool shows the host's account instead. The model already received
 * the runtime's text; only what the conversation shows changes.
 */
import type { HostStopCause } from "@schlessera/brain-ui-sdk/protocol";

const BECAUSE: Record<HostStopCause, string> = {
  safety_recording: "it couldn't record the turn's safety checks",
  change_journal: "it couldn't record the turn's changes",
  approval_record: "it couldn't save an approval's outcome",
  inbox_share: "it couldn't link this chat's inbox shares",
};

/** The status row of a host-stopped turn; `null` is a cause this client does not know. */
export function hostStopNoticeCopy(cause: HostStopCause | null): { tag: string; body: string } {
  const next = cause === "change_journal" ? "Check any partial work, then try again." : "Try again.";
  return {
    tag: "Stopped by the host",
    body: cause ? `The host stopped this turn because ${BECAUSE[cause]}. ${next}` : `The host stopped this turn. ${next}`,
  };
}

/** What a tool the host cut short shows in place of the runtime's refusal text. */
export function hostStopToolOutput(cause: HostStopCause): string {
  return `The host stopped this turn before this tool finished, because ${BECAUSE[cause]}. You didn't refuse it.`;
}
