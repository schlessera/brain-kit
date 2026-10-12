/** Host-recorded facts for one turn; absent counts and prices are never zero. */
export interface TurnJournalSummary {
  state: "recording" | "complete" | "partial" | "expired" | "unknown" | "unrecorded";
  changedFiles: number | null;
  steeringFiles: number | null;
  costUsd: number | null;
  costIsEstimate: boolean | null;
  profile: "strict" | "governed" | null;
  actor: "interactive" | "voice" | null;
  model: string | null;
  policyHash: string | null;
  sharedAttribution: boolean;
  observedAt: number | null;
}

export interface JournalVersion {
  kind: "file" | "symlink" | "other";
  mode: number;
  bytes: number;
  hash?: string;
  target?: string;
  ignored: boolean;
}

export interface TurnJournalChange {
  sequence: number;
  path: string;
  scope: string;
  class: "content" | "steering" | "policy";
  actor: "agent" | "user";
  before: JournalVersion | null;
  after: JournalVersion | null;
  overlappingTurnIds: string[];
}

export interface TurnJournalDetails {
  turnId: string;
  sessionId: string;
  summary: TurnJournalSummary;
  changes: TurnJournalChange[];
  missing: { path: string; reason: string }[];
}
