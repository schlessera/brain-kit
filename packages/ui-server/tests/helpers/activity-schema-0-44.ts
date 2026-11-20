/** Frozen activity parsers from the published ui-sdk 0.44.0 tarball.
 * Registry SHA-1: 136f943d939188a719b5e9904d46733c85e343c1.
 * Type-only satisfies clauses are omitted; validators are unchanged.
 * The pre-stream schema at epic base 134c0eee9 also validates subPhases.
 */
import { z } from "zod";
const id = z.string().min(1).max(256);
const activityView = z.enum(["index", "session", "run"]);

const modelUsageSchema = z.looseObject({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheCreationTokens: z.number().optional(),
  costUsd: z.number().optional(),
});

const activitySpanSchema = z.looseObject({
  spanId: id,
  runId: id,
  parentSpanId: id.optional(),
  name: z.string(),
  toolName: z.string().optional(),
  kind: z.enum(["turn", "tool", "subagent", "cron"]),
  origin: z.enum(["session", "cron", "autonomous"]),
  sessionId: id.optional(),
  jobName: z.string().optional(),
  principalId: id.optional(),
  startedAt: z.number(),
  waitUntil: z.number().optional(),
  endedAt: z.number().optional(),
  outcome: z.enum(["success", "error", "timeout", "cancelled", "denied", "interrupted"]).optional(),
  outcomeReason: z.string().optional(),
  usage: modelUsageSchema.extend({ model: z.string().optional() }).optional(),
  subagent: z
    .looseObject({
      type: z.string().optional(),
      description: z.string().optional(),
      summary: z.string().optional(),
      totalTokens: z.number().optional(),
    })
    .optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const activitySpanEventSchema = z.looseObject({
  spanId: id,
  eventIndex: z.number(),
  ts: z.number(),
  eventType: z.string(),
  payload: z.unknown().optional(),
  truncated: z.boolean().optional(),
});

const activityTurnLifecycleSchema = z.looseObject({
  hostEvents: z.array(z.looseObject({principalId: id, kind: z.enum(["turn_cancelled", "ask_user_cancelled", "principal_revoked", "follow_up"]), observedAt: z.number()})),
  skippedPhases: z.array(z.enum(["governed", "budget", "journal"])),
  lifecycleId: id, turnId: id, sessionId: id.nullable(), backendRunId: id.nullable(),
  acceptedAt: z.number(),
  dequeuedAt: z.number().nullable(),
  governedStartedAt: z.number().nullable(),
  governedAcquiredAt: z.number().nullable(),
  budgetStartedAt: z.number().nullable(),
  budgetAdmittedAt: z.number().nullable(),
  journalStartedAt: z.number().nullable(),
  journalBeganAt: z.number().nullable(),
  backendInvokedAt: z.number().nullable(),
  firstFrameAt: z.number().nullable(),
  failureObservedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  totalElapsedMs: z.number().nullable(),
  timeToFirstFrameMs: z.number().nullable(),
  queueWaitMs: z.number().nullable(),
  governedAdmissionMs: z.number().nullable(),
  budgetAdmissionMs: z.number().nullable(),
  journalBeginMs: z.number().nullable(),
  backendStartupMs: z.number().nullable(),
  outcome: z.enum(["success", "error", "timeout", "cancelled", "denied", "interrupted"]).nullable(), reason: z.string().nullable(),
});

export const serverActivitySnapshotSchema = z.looseObject({
  type: z.literal("activity_snapshot"),
  lifecycles: z.array(activityTurnLifecycleSchema).optional(),
  view: activityView,
  sessionId: id.optional(),
  runId: id.optional(),
  spans: z.array(activitySpanSchema),
  events: z.array(activitySpanEventSchema),
  highWaterSeq: z.record(z.string(), z.number()),
  append: z.boolean().optional(),
});

export const serverActivityDeltaSchema = z.looseObject({
  type: z.literal("activity_delta"),
  lifecycle: activityTurnLifecycleSchema.optional(),
  runId: id,
  seq: z.number(),
  span: activitySpanSchema.optional(),
  event: activitySpanEventSchema.optional(),
});

// Freeze the later pre-stream phase vocabulary too: adding a new phase
// would be rejected by that stricter consumer of timing records.
const previousLifecycle = activityTurnLifecycleSchema.extend({
  subPhases: z.array(z.looseObject({ phase: z.enum(["governed", "journal"]), name: z.string(), startedAt: z.number(),
    endedAt: z.number().nullable(), elapsedMs: z.number().nullable() })).optional(),
});
export const previousSnapshotSchema = serverActivitySnapshotSchema.extend({ lifecycles: z.array(previousLifecycle).optional() });
export const previousDeltaSchema = serverActivityDeltaSchema.extend({ lifecycle: previousLifecycle.optional() });
