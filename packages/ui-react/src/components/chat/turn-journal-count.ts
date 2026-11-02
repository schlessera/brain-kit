import type { TurnJournalSummary } from "@schlessera/brain-ui-sdk/protocol";

/**
 * The collapsed receipt's change count. Only retained content, steering,
 * policy and workspace paths read as files (`keptFiles`, #3255). A summary
 * without that count, recorded before it existed, names its recorded entries,
 * which may be index or ignored paths, never files. A partial journal's count
 * is a lower bound.
 */
export function turnJournalChangeCount(summary: TurnJournalSummary | undefined): string {
  const kept = summary?.keptFiles, recorded = summary?.changedFiles, atLeast = summary?.state === "partial" ? "At least " : "";
  if (kept != null) return `${atLeast}${kept} changed ${kept === 1 ? "file" : "files"}`;
  if (recorded != null) return `${atLeast}${recorded} ${recorded === 1 ? "entry" : "entries"} recorded`;
  return "Changes unknown";
}
