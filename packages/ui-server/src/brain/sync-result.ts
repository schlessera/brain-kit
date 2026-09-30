/**
 * The result `brain sync --json` prints (#290,
 * docs/integration-contract.md), read by both scheduling paths: the
 * in-process scheduler through `BrainClient.sync`, and the container cron
 * wrapper for its `sync` job. Both record it on the run's root span with
 * {@link syncActivityAttrs}, the attributes chat's `runtime_observed` writes,
 * so `/api/status` reads one representation whichever path ran.
 */

/** Whether the sync invoked an agent, and what that agent reported. */
export type BrainSyncAgent =
  | { invoked: false; reason: "not-needed" | "no-runner" }
  | {
      invoked: true;
      runner: string;
      outcome: "success" | "failed";
      runtime: { name: string; version: string | null } | null;
      text: string | null;
      error?: string;
    };

/** The fields of `brain sync --json` read here; the run envelope carries more. */
export interface BrainSyncOutput {
  run: { status: "complete" | "needs-judgment" | "failed"; report: string; [field: string]: unknown };
  agent: BrainSyncAgent;
}

const RUN_STATUSES = new Set(["complete", "needs-judgment", "failed"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function readAgent(value: unknown): BrainSyncAgent | null {
  if (!isRecord(value)) return null;
  if (value.invoked === false) {
    return value.reason === "not-needed" || value.reason === "no-runner"
      ? { invoked: false, reason: value.reason }
      : null;
  }
  if (value.invoked !== true) return null;
  if (typeof value.runner !== "string") return null;
  if (value.outcome !== "success" && value.outcome !== "failed") return null;
  if (value.text !== null && typeof value.text !== "string") return null;
  if (value.error !== undefined && typeof value.error !== "string") return null;
  let runtime: { name: string; version: string | null } | null;
  if (value.runtime === null) runtime = null;
  else if (
    isRecord(value.runtime) &&
    typeof value.runtime.name === "string" &&
    value.runtime.name !== "" &&
    (value.runtime.version === null || (typeof value.runtime.version === "string" && value.runtime.version !== ""))
  ) {
    runtime = { name: value.runtime.name, version: value.runtime.version };
  } else return null;
  return {
    invoked: true,
    runner: value.runner,
    outcome: value.outcome,
    runtime,
    text: value.text,
    ...(value.error !== undefined ? { error: value.error } : {}),
  };
}

/**
 * `stdout` as a sync result, or null when it is not one — text from a CLI
 * older than the result, a truncated document, anything malformed. Null means
 * nothing is known about the agent; it never means "no agent ran".
 */
export function parseSyncResult(stdout: string): BrainSyncOutput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.run)) return null;
  const { run } = parsed;
  if (typeof run.status !== "string" || !RUN_STATUSES.has(run.status) || typeof run.report !== "string") return null;
  const agent = readAgent(parsed.agent);
  if (!agent) return null;
  return { run: run as BrainSyncOutput["run"], agent };
}

/** The readable text of a sync: its report, then the agent's final text. */
export function syncMessage(result: BrainSyncOutput): string {
  const text = result.agent.invoked ? result.agent.text : null;
  return [result.run.report.trim(), text?.trim()].filter(Boolean).join("\n");
}

/**
 * The root-span attributes for one sync run. `brain.runtime.*` is chat's
 * `runtime_observed` representation and is set only from this run's own
 * observation: an agent not invoked, a runtime not reported, or a result
 * that could not be read (`null`) writes none, so no run inherits another's
 * version. `brain.sync.agent` is the invocation state: `not-invoked`,
 * `invoked`, or `unknown` when the result could not be read.
 */
export function syncActivityAttrs(result: BrainSyncOutput | null): Record<string, string> {
  if (!result) return { "brain.sync.agent": "unknown" };
  const { agent } = result;
  const attrs: Record<string, string> = { "brain.sync.run_status": result.run.status };
  if (!agent.invoked) {
    attrs["brain.sync.agent"] = "not-invoked";
    attrs["brain.sync.agent_reason"] = agent.reason;
    return attrs;
  }
  attrs["brain.sync.agent"] = "invoked";
  attrs["brain.sync.agent_runner"] = agent.runner;
  attrs["brain.sync.agent_outcome"] = agent.outcome;
  if (agent.runtime) {
    attrs["brain.runtime.name"] = agent.runtime.name;
    if (agent.runtime.version !== null) attrs["brain.runtime.version"] = agent.runtime.version;
  }
  return attrs;
}
