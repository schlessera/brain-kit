/** Host-recorded facts for one turn; absent counts and prices are never zero. */
export interface TurnJournalSummary {
  state: "recording" | "complete" | "partial" | "expired" | "unknown" | "unrecorded";
  changedFiles: number | null;
  steeringFiles: number | null;
  costUsd: number | null;
  costIsEstimate: boolean | null;
  profile: "strict" | "governed" | null;
  actor: "interactive" | "voice" | "user" | null;
  kind?: "turn" | "revert";
  sourceTurnId?: string;
  model: string | null;
  policyHash: string | null;
  sharedAttribution: boolean;
  observedAt: number | null;
  /** List-price inference budget facts; effective costUsd above remains billing-aware. */
  budget?: import("./turn-budgets.js").TurnBudgetReceipt;
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

/** An admission receipt, not a claim that the external action completed. */
export interface JournalOutwardAction {
  id: number;
  at: number;
  tool: string;
  action: "git_push" | "gh_write" | "mcp_tool" | "http_write" | "outward_host_connect";
  target: string | null;
  decision: "policy_allowed" | "approved" | "declined" | "refused";
  historyRewrite: boolean;
  /** Restoring local files cannot undo an external action. */
  revertible: false;
}

export interface TurnJournalDetails {
  turnId: string;
  sessionId: string;
  summary: TurnJournalSummary;
  changes: TurnJournalChange[];
  missing: { path: string; reason: string }[];
  outwardActions?: JournalOutwardAction[];
  /** The details endpoint bounds rows; retained governance records remain queryable. */
  outwardActionsTruncated?: boolean;
}

export interface TurnRevertPath {
  path: string;
  state: "eligible" | "excluded" | "restored" | "conflict" | "failed";
  reason: string | null;
  quarantined: boolean;
}
export interface TurnRevertPlan {
  turnId: string;
  action: "revert" | "restore";
  paths: TurnRevertPath[];
}
export interface TurnRevertReceipt {
  id: string;
  sourceTurnId: string;
  journalTurnId: string;
  state: "waiting" | "applying" | "complete" | "partial" | "failed" | "unknown";
  action: "revert" | "restore";
  undoAvailable: boolean;
  paths: TurnRevertPath[];
  error: string | null;
}
