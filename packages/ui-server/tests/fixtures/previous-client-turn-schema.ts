/** Frozen pre-receipt Activity schemas from commit 134c0eee9, schemas.ts.
 * Only TypeScript `satisfies` annotations were removed; runtime validators,
 * including every closed enum and required field, are copied verbatim. */
import { z } from "zod";
const MAX_ID_CHARS = 256;
const id = z.string().min(1).max(MAX_ID_CHARS);
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
  origin: z.enum(["session", "cron", "autonomous", "compute"]),
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
  subPhases: z.array(z.looseObject({ phase: z.enum(["governed", "journal"]), name: z.string(), startedAt: z.number(),
    endedAt: z.number().nullable(), elapsedMs: z.number().nullable() })).optional(),
  outcome: z.enum(["success", "error", "timeout", "cancelled", "denied", "interrupted"]).nullable(), reason: z.string().nullable(),
});

const serverActivitySnapshotSchema = z.looseObject({
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

const serverActivityDeltaSchema = z.looseObject({
  type: z.literal("activity_delta"),
  lifecycle: activityTurnLifecycleSchema.optional(),
  runId: id,
  seq: z.number(),
  span: activitySpanSchema.optional(),
  event: activitySpanEventSchema.optional(),
});

export const previousActivityFrameSchema = z.discriminatedUnion("type", [serverActivitySnapshotSchema, serverActivityDeltaSchema]);
