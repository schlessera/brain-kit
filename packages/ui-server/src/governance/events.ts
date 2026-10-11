import type { Database } from "bun:sqlite";
import { z } from "zod";

/**
 * Governance events (#1651): one machine-readable record for every sandbox or
 * governance intervention in a turn, kept in `brain-ui.db` with the session's
 * catalog row instead of with the 7-day Activity span detail
 * (docs/decisions/governed-writable-workers.md, "Roadblocks and governance
 * events"). Records are quiet: nothing here renders to the user. They are
 * read through `GET /api/governance/events` (docs/http-api.md).
 *
 * Every kind has exactly one current payload schema and version. A payload
 * change that is not purely additive bumps that kind's `version`; stored rows
 * keep the version they were written with, and readers get them as stored.
 */

const path = z.string().min(1).max(4096);
const text = z.string().max(2000);
const count = z.number().int().nonnegative();
const amount = z.number().finite().nonnegative();
/** Tool input as recorded: emitters cap it and say so, never a silent cut. */
const toolInput = {
  tool: z.string().min(1).max(200),
  input: z.string().max(8192),
  inputTruncated: z.boolean(),
};
/** The policy rule that decided, by its position in the policy file. */
const policyRule = (list: readonly [string, ...string[]]) => z.strictObject({
  list: z.enum(list),
  index: count,
  pattern: z.string().min(1).max(1000),
  reason: text.optional(),
});
/** The hash of the policy that governed the turn; null under built-in defaults. */
const policyHash = z.string().min(1).max(128).nullable();
/** Where a limit came from: the brain's policy file or a built-in default. */
const limitSource = z.enum(["policy", "default"]);
const budget = {
  scope: z.enum(["turn", "session", "day"]),
  unit: z.enum(["usd", "tokens"]),
  limit: amount,
  observed: amount,
  source: limitSource,
};
const ROADBLOCK_CATEGORIES = ["tool_error", "shell_nonzero", "fs_denied", "permission_denied", "policy_block",
  "budget", "scope_cap", "network_refused", "retry"] as const;
const roadblockCall = z.strictObject({
  toolCallId: z.string().min(1).max(200).nullable(),
  signature: z.string().min(1).max(1000),
});

function kind<T extends z.ZodType>(version: number, payload: T) {
  return { version, payload };
}

/**
 * The closed set of kinds and their payloads. Field meanings are specified in
 * docs/http-api.md ("Governance events"); keep the two in step.
 */
export const GOVERNANCE_EVENT_SCHEMAS = {
  /** A linked turn-temp file copied into persistent scratch (#1655). */
  promotion: kind(1, z.strictObject({
    source: path,
    destination: path,
    bytes: count,
    originalLink: text,
    rewrittenLink: text,
  })),
  /** A linked turn-temp file that was not copied; the link is unchanged (#1655). */
  promotion_refused: kind(1, z.strictObject({
    source: path,
    originalLink: text,
    reason: z.enum(["file_too_large", "turn_too_large", "not_regular_file", "symlink", "multiple_links", "missing", "io_error"]),
    bytes: count.nullable(),
    limitBytes: count.nullable(),
  })),
  /** A command refused by the policy's `commands.deny` (#1661). */
  policy_block: kind(1, z.strictObject({
    ...toolInput,
    rule: policyRule(["commands.deny"]),
    policyHash,
  })),
  /** A command that matched `commands.confirm`, with the user's answer (#1661). */
  policy_confirm: kind(1, z.strictObject({
    ...toolInput,
    rule: policyRule(["commands.confirm"]),
    decision: z.enum(["approved", "declined", "timed_out", "cancelled"]),
    policyHash,
  })),
  /** A write refused because the path is protected or the profile is read-only. */
  read_only_refusal: kind(1, z.strictObject({
    path,
    protection: z.enum(["tier_a", "tier_b", "policy_protect", "strict_profile", "restricted_profile"]),
    code: z.enum(["EROFS", "EACCES", "EBUSY"]).nullable(),
    tool: z.string().min(1).max(200).nullable(),
    alternative: text.nullable(),
  })),
  /** A protected file that appeared during a turn, moved into the journal quarantine. */
  quarantine: kind(1, z.strictObject({
    path,
    tier: z.enum(["A", "B"]),
    entry: z.enum(["file", "directory", "symlink", "other"]),
    bytes: count.nullable(),
    trigger: z.enum(["turn_end", "boot_recovery"]),
    objectId: z.string().min(1).max(200),
  })),
  /** One reconciliation pass over turns that left protected names behind. */
  quarantine_reconciliation: kind(1, z.strictObject({
    trigger: z.enum(["boot_recovery", "launch"]),
    reconciledTurnIds: z.array(z.string().min(1).max(200)).max(1000),
    quarantined: count,
    masked: z.array(path).max(1000),
  })),
  /** A budget's warn limit crossed; recorded once per crossing (#1669). */
  budget_warning: kind(1, z.strictObject(budget)),
  /** A budget's block limit reached: refused, aborted or stopped by the backstop (#1669). */
  budget_block: kind(1, z.strictObject({
    ...budget,
    stage: z.enum(["admission", "mid_turn", "sdk_backstop"]),
  })),
  /** A per-turn scope cap or the free-space floor reached, and how it ended (#1670). */
  scope_cap: kind(1, z.strictObject({
    cap: z.enum(["files_changed", "minutes", "tool_calls", "free_space_floor", "turn_bytes"]),
    limit: amount,
    observed: amount,
    overshoot: amount,
    frozen: z.boolean(),
    outcome: z.enum(["continued", "stopped", "voice_stopped", "turn_ended"]),
    source: limitSource,
  })),
  /** A connection the egress proxy refused. */
  egress_denial: kind(1, z.strictObject({
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535),
    method: z.string().min(1).max(20).nullable(),
    reason: z.enum(["denied_host", "not_allowlisted", "byte_cap", "taint_allowlist"]),
    bytes: count.nullable(),
  })),
  /** A turn that asked for `governed` and ran under `strict`, and why. */
  strict_fallback: kind(1, z.strictObject({
    path,
    reason: z.enum(["symlink", "hardlink", "mount_point"]),
  })),
  /** Paths a revert skipped because they changed after the reverted turn. */
  revert_conflict: kind(1, z.strictObject({
    conflicts: z.array(z.strictObject({
      path,
      state: z.enum(["changed", "deleted", "created", "type_changed"]),
    })).min(1).max(10_000),
    restored: count,
  })),
  /** An action outside the brain in the user's name, allowed or not (#1664). */
  outward_action: kind(1, z.strictObject({
    ...toolInput,
    action: z.enum(["git_push", "gh_write", "mcp_tool", "http_write", "outward_host_connect"]),
    target: text.nullable(),
    historyRewrite: z.boolean(),
    tainted: z.boolean(),
    decision: z.enum(["policy_allowed", "approved", "declined", "refused"]),
    rule: policyRule(["outward.allow"]).nullable(),
  })),
  /** The first untrusted input that tainted the session. */
  taint: kind(1, z.strictObject({
    source: z.enum(["web_fetch", "web_search", "staged_share", "workspace_read", "mcp_document", "user_marked",
      "egress_connection", "fetching_command", "unclassified_command"]),
    tool: z.string().min(1).max(200).nullable(),
    detail: text.nullable(),
  })),
  /** A provider a worker command needed but could not reach without a key (#1666). */
  provider_unavailable: kind(1, z.strictObject({
    provider: z.string().min(1).max(100),
    capability: z.string().min(1).max(100),
    command: text.nullable(),
    degradedTo: z.string().min(1).max(100).nullable(),
  })),
  /** A worker that hit an rlimit or cgroup limit (#1660). */
  resource_limit: kind(1, z.strictObject({
    limits: z.array(z.strictObject({
      limit: z.enum(["processes", "memory", "pids", "file_size", "data", "cpu"]),
      source: z.enum(["rlimit", "cgroup"]),
      value: amount,
      events: count.nullable(),
    })).min(1).max(20),
    fatal: z.boolean(),
  })),
  /** One classified roadblock episode in a turn (#1671). */
  roadblock: kind(1, z.strictObject({
    category: z.enum(ROADBLOCK_CATEGORIES),
    family: z.string().min(1).max(200),
    signature: z.string().min(1).max(1000),
    failures: z.array(roadblockCall.extend({ category: z.enum(ROADBLOCK_CATEGORIES) })).min(1).max(200),
    resolution: roadblockCall.nullable(),
    remedy: z.enum(["guidance", "capability"]),
    // Unknown tokens or cost stay null: the cost-tracking rules forbid zero.
    waste: z.strictObject({ tokens: count.nullable(), costUsd: amount.nullable(), ms: count }),
    eventIds: z.array(z.number().int().positive()).max(200),
  })),
} as const;

export type GovernanceEventKind = keyof typeof GOVERNANCE_EVENT_SCHEMAS;
export type GovernanceEventPayload<K extends GovernanceEventKind> = z.infer<(typeof GOVERNANCE_EVENT_SCHEMAS)[K]["payload"]>;
export const GOVERNANCE_EVENT_KINDS = Object.keys(GOVERNANCE_EVENT_SCHEMAS) as GovernanceEventKind[];

/**
 * Who caused the intervention: a turn of the named posture, the user acting
 * outside a turn (a revert, an approval), the server on its own (boot
 * reconciliation), or a change made outside any turn or server path.
 */
export const GOVERNANCE_ACTORS = ["interactive", "voice", "autonomous", "user", "server", "external"] as const;
export type GovernanceActor = (typeof GOVERNANCE_ACTORS)[number];
export const GOVERNANCE_PROFILES = ["governed", "strict", "restricted"] as const;
export type GovernanceProfile = (typeof GOVERNANCE_PROFILES)[number];

/** A serialized payload above this is refused: emitters cap what they record. */
export const GOVERNANCE_PAYLOAD_MAX_BYTES = 64 * 1024;
/**
 * Events whose turn never named a session (a new conversation refused at
 * admission, a crash before `session_info`) have no catalog row to live with.
 * They are kept this long, matching the Activity hard ceiling.
 */
export const UNBOUND_GOVERNANCE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const id = z.string().min(1).max(200);
const attribution = z.strictObject({
  sessionId: id.nullable(),
  turnId: id.nullable(),
  actor: z.enum(GOVERNANCE_ACTORS),
  model: z.string().min(1).max(200).nullable(),
  profile: z.enum(GOVERNANCE_PROFILES).nullable(),
  at: z.number().int().nonnegative().optional(),
  /** Makes a retried or re-run write idempotent: one row per kind and key. */
  dedupeKey: z.string().min(1).max(500).optional(),
});

export type GovernanceEventInput<K extends GovernanceEventKind = GovernanceEventKind> = z.input<typeof attribution> & {
  kind: K;
  payload: GovernanceEventPayload<K>;
};

export class GovernanceEventError extends Error {
  override name = "GovernanceEventError";
}

/** The stored record as the read API returns it. */
export interface GovernanceEvent {
  id: number;
  sessionId: string | null;
  turnId: string | null;
  at: number;
  kind: string;
  schemaVersion: number;
  actor: GovernanceActor;
  model: string | null;
  profile: GovernanceProfile | null;
  payload: Record<string, unknown>;
}

export function isGovernanceEventKind(value: string): value is GovernanceEventKind {
  return Object.hasOwn(GOVERNANCE_EVENT_SCHEMAS, value);
}

/**
 * The one writer. Throws `GovernanceEventError` on an unknown kind, a payload
 * that does not match its kind's schema, bad attribution or an oversized
 * payload; database failures propagate. Returns the row id, and whether this
 * call stored it (false when `dedupeKey` already recorded the event).
 *
 * The session is attached only when its catalog row exists, so an emitter
 * never has to know whether `session_info` has landed yet; `bindTurnEvents`
 * attaches the rest when it does.
 */
export function recordGovernanceEvent(db: Database, input: GovernanceEventInput): { id: number; recorded: boolean } {
  if (typeof input?.kind !== "string" || !isGovernanceEventKind(input.kind)) {
    throw new GovernanceEventError(`Unknown governance event kind: ${String(input?.kind)}`);
  }
  const spec = GOVERNANCE_EVENT_SCHEMAS[input.kind];
  const { kind: _kind, payload: rawPayload, ...rest } = input;
  const meta = attribution.safeParse(rest);
  if (!meta.success) throw new GovernanceEventError(`Invalid governance event attribution: ${z.prettifyError(meta.error)}`);
  const payload = spec.payload.safeParse(rawPayload);
  if (!payload.success) throw new GovernanceEventError(`Invalid ${input.kind} payload: ${z.prettifyError(payload.error)}`);
  const json = JSON.stringify(payload.data);
  if (Buffer.byteLength(json, "utf8") > GOVERNANCE_PAYLOAD_MAX_BYTES) {
    throw new GovernanceEventError(`${input.kind} payload exceeds ${GOVERNANCE_PAYLOAD_MAX_BYTES} bytes`);
  }
  const m = meta.data;
  const at = m.at ?? Date.now();
  return db.transaction(() => {
    db.query("DELETE FROM governance_events WHERE session_id IS NULL AND at < ?").run(at - UNBOUND_GOVERNANCE_RETENTION_MS);
    const row = db.query(`INSERT INTO governance_events
        (session_id, turn_id, at, kind, schema_version, actor, model, profile, payload, dedupe_key)
      VALUES ((SELECT id FROM sessions WHERE id = ?1), ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
      ON CONFLICT(kind, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
      RETURNING id`)
      .get(m.sessionId, m.turnId, at, input.kind, spec.version, m.actor, m.model, m.profile, json, m.dedupeKey ?? null) as { id: number } | null;
    if (row) return { id: row.id, recorded: true };
    const existing = db.query("SELECT id FROM governance_events WHERE kind = ? AND dedupe_key = ?")
      .get(input.kind, m.dedupeKey ?? null) as { id: number };
    return { id: existing.id, recorded: false };
  }).immediate();
}

/**
 * Attach a turn's session-less events to its session, once the session's
 * catalog row exists. Returns how many rows it bound.
 */
export function bindTurnEvents(db: Database, turnId: string, sessionId: string): number {
  return db.query(`UPDATE governance_events SET session_id = ?1
    WHERE turn_id = ?2 AND session_id IS NULL AND EXISTS (SELECT 1 FROM sessions WHERE id = ?1)`)
    .run(sessionId, turnId).changes;
}

export interface GovernanceEventQuery {
  sessionId?: string;
  turnId?: string;
  kinds?: GovernanceEventKind[];
  /** Exclusive cursor: only events with a larger id. */
  after?: number;
  limit: number;
}

interface Row {
  id: number; session_id: string | null; turn_id: string | null; at: number; kind: string; schema_version: number;
  actor: GovernanceActor; model: string | null; profile: GovernanceProfile | null; payload: string;
}

/** Events in id order, filtered by every given field. */
export function queryGovernanceEvents(db: Database, query: GovernanceEventQuery): GovernanceEvent[] {
  const where: string[] = ["id > ?"];
  const params: Array<string | number> = [query.after ?? 0];
  if (query.sessionId !== undefined) { where.push("session_id = ?"); params.push(query.sessionId); }
  if (query.turnId !== undefined) { where.push("turn_id = ?"); params.push(query.turnId); }
  if (query.kinds?.length) {
    where.push(`kind IN (${query.kinds.map(() => "?").join(", ")})`);
    params.push(...query.kinds);
  }
  params.push(query.limit);
  const rows = db.query(`SELECT id, session_id, turn_id, at, kind, schema_version, actor, model, profile, payload
    FROM governance_events WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`).all(...params) as Row[];
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    at: row.at,
    kind: row.kind,
    schemaVersion: row.schema_version,
    actor: row.actor,
    model: row.model,
    profile: row.profile,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  }));
}
