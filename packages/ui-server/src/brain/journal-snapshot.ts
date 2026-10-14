/** Shared observed-version types; native capture owns journal observations. */
export interface JournalSnapshotEntry {
  path: string;
  scope: string;
  kind: "file" | "symlink" | "other";
  mode: number;
  bytes: number;
  /** Host-only identity/cache facts; ignored changes are detectable without retaining their contents. */
  stamp: string;
  hash?: string;
  target?: string;
  ignored: boolean;
}
export interface JournalSnapshot {
  entries: JournalSnapshotEntry[];
  missing: { path: string; reason: string }[];
}
