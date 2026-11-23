/** Active-turn aggregates, advanced only from committed change rows (#4294). */
import type { JournalVersion } from "@schlessera/brain-ui-sdk/protocol";
import { isWithin } from "@schlessera/brain-common/internal/safe-path";
import { BRAIN_WORKSPACES_DIR } from "@schlessera/brain-common/internal/worker-areas";
import { INDEX_FAMILY_PATHS, journalMetadataOnlyPath } from "./native-journal-policy.js";

export interface CounterChange {
  sequence: number; path: string; before_json: string | null; after_json: string | null; class: string; overlaps: string;
}
interface PathCounters { hashed: number; ignored: number; steering: boolean; kept: boolean; shared: boolean; present: boolean }
const indexFamily = new Set(INDEX_FAMILY_PATHS);
export class JournalObservationCounters {
  sequence = 0;
  private readonly paths = new Map<string, PathCounters>();
  readonly counts = { changedFiles: 0, steeringFiles: 0, keptFiles: 0, sharedAttribution: 0 };
  readonly facts = { changedPaths: 0, observedBytes: 0, workspacePaths: 0 };
  append(rows: readonly CounterChange[]): void {
    for (const row of rows) {
      if (row.sequence <= this.sequence) continue;
      const before = row.before_json ? JSON.parse(row.before_json) as JournalVersion : null;
      const after = row.after_json ? JSON.parse(row.after_json) as JournalVersion : null;
      const old = this.paths.get(row.path);
      if (old) this.charge(row.path, old, -1);
      const disposable = indexFamily.has(row.path) || after?.metadataOnly === true;
      const value: PathCounters = {
        hashed: (old?.hashed ?? 0) + (after?.kind === "file" && !after.ignored && !disposable && after.hash !== before?.hash ? after.bytes : 0),
        ignored: Math.max(old?.ignored ?? 0, after?.kind === "file" && (after.ignored || disposable) ? after.bytes : 0),
        steering: old?.steering === true || row.class === "steering",
        kept: old?.kept === true || (!journalMetadataOnlyPath(row.path) && !before?.metadataOnly && !after?.metadataOnly && !before?.ignored && !after?.ignored && (before !== null || after !== null) && (before?.kind ?? after?.kind) !== "other"),
        shared: old?.shared === true || row.overlaps !== "[]",
        present: after !== null,
      };
      this.paths.set(row.path, value); this.charge(row.path, value, 1);
      this.sequence = row.sequence;
    }
  }
  private charge(path: string, value: PathCounters, sign: number): void {
    this.counts.changedFiles += sign;
    if (value.steering) this.counts.steeringFiles += sign;
    if (value.kept) this.counts.keptFiles += sign;
    if (value.shared) this.counts.sharedAttribution += sign;
    // A removed host publication copy never charged the turn. Its past
    // versions count again if a later observation sees the copy reappear.
    if (!value.present && journalMetadataOnlyPath(path) && !indexFamily.has(path)) return;
    this.facts.changedPaths += sign;
    this.facts.observedBytes += sign * (value.hashed + value.ignored);
    if (isWithin(BRAIN_WORKSPACES_DIR, path, { includeRoot: false })) this.facts.workspacePaths += sign;
  }
}
