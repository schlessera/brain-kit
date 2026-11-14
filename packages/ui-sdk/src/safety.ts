/** Host-owned safety sidecars. Never provider conversation data. */
import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const revision = z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(v => BigInt(v) <= 18446744073709551615n);
const text = (bytes: number) => z.string().refine(v => new TextEncoder().encode(v).length <= bytes);
const time = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const safetySessionKeySchema = z.strictObject({ sessionId: id, historyOwnerId: id, historyGeneration: revision });
export const safetyTargetSchema = z.union([z.strictObject({ sessionId: id }), z.strictObject({ turnId: id, bindingId: id })]);
export const safetyIdentitySchema = z.union([safetySessionKeySchema, z.strictObject({ turnId: id, bindingId: id })]);
export const safetyProjectionSchema = z.strictObject({ session: safetySessionKeySchema.nullable(), evidenceRevision: revision,
  unresolvedCount: z.number().int().min(0).max(100000), earliestUnresolvedId: id.nullable(), pendingCount: z.number().int().min(0).max(256),
  restriction: z.enum(["normal", "restricted"]), reasons: z.array(z.enum(["unresolved", "coverage_unknown", "recording_pending", "recording_failed", "capacity"])).max(5),
  coverage: z.strictObject({ detectorVersion: z.literal(1), state: z.enum(["complete", "incomplete", "unknown"]),
    epochs: z.array(z.strictObject({ id, backendId: id, startSequence: revision, endSequence: revision.nullable(),
      mandatory: z.array(id).max(32), acknowledged: z.array(id).max(32), status: z.enum(["complete", "incomplete", "unknown"]), reason: text(512).nullable() })).max(128),
    exclusions: z.array(id).max(4) }) });
const source = z.enum(["web_fetch", "web_search", "staged_share", "chat_attachment", "workspace_read", "mcp_document", "user_marked", "fetching_command", "unclassified_command", "compute_output", "apify_result", "egress_connection", "legacy_unknown"]);
const exposure = z.enum(["open", "finalized", "interrupted_unknown"]);
const provenance = z.union([z.null(), z.strictObject({ kind: z.literal("web_origin"), origin: z.strictObject({scheme:z.enum(["http","https"]),host:text(253),port:z.number().int().min(1).max(65535)}), verifiedBy:z.literal("host_transport") }),
  z.strictObject({kind:z.literal("tunnel_authority"),authority:z.strictObject({host:text(253),port:z.number().int().min(1).max(65535)}),verifiedBy:z.literal("host_proxy")})]);
const common = { id, sequence: revision, observedAt: time, turnId: id, bindingId: id, occurrenceId: id, detailPruned: z.boolean() };
export const safetyRecordSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...common, kind:z.literal("occurrence"), epochId:id, detector:id.nullable(), source, operationId:id.nullable(), signalId:id.nullable(), exposureId:id.nullable(), exposure,
    summary:text(2048), provenance, entry:z.strictObject({kind:z.literal("tool"),toolUseId:id}).optional() }),
  z.strictObject({ ...common, kind:z.literal("exposure"), state:exposure }),
  z.strictObject({ ...common, kind:z.literal("safe_decision"), session:safetySessionKeySchema, requestId:id, principalId:id, verdict:z.literal("safe"), channel:z.enum(["owner_history","owner_settings"]) }),
]);
export const safetyPageSchema = z.strictObject({ version:z.literal(1), identity:safetyIdentitySchema, snapshotId:id, cursor:z.string().max(512).nullable(), highWater:revision,
  projection:safetyProjectionSchema, records:z.array(safetyRecordSchema).max(100), nextCursor:z.string().max(512).nullable(), snapshotComplete:z.boolean(), detailPruned:z.boolean() });
export const safetyUpdateSchema = z.strictObject({ version:z.literal(1), identity:safetyIdentitySchema, fromRevision:revision, toRevision:revision,
  projection:safetyProjectionSchema, records:z.array(safetyRecordSchema).max(100) });
export const safetyUnavailableSchema = z.strictObject({ version:z.literal(1), reason:z.enum(["unavailable","unauthorized","expired","capacity","generation_changed","gap"]) });
export const safetyCapabilitiesSchema = z.strictObject({ version:z.literal(1), read:z.literal(true), review:z.boolean(), originRules:z.literal(false), repositoryRules:z.literal(false), recipientRules:z.literal(false),
  readOnlyReason:z.enum(["review_unavailable","owner_required"]).nullable(), detectorVersion:z.literal(1), limits:z.strictObject({ pageRecords:z.literal(100), frameBytes:z.literal(262144), cursorBytes:z.literal(512), cursorLifetimeMs:z.literal(300000),
    reviewBodyBytes:z.literal(16384).optional(), reviewLifetimeMs:z.literal(900000).optional(), receiptLifetimeMs:z.literal(86400000).optional() }) });
export const SESSION_SAFETY_CAPABILITY = "sessionSafetyHistory";
export const SAFETY_READ_CAPABILITIES = safetyCapabilitiesSchema.parse({version:1,read:true,review:false,originRules:false,repositoryRules:false,recipientRules:false,readOnlyReason:"review_unavailable",detectorVersion:1,
  limits:{pageRecords:100,frameBytes:262144,cursorBytes:512,cursorLifetimeMs:300000}});
export type SafetySessionKey = z.infer<typeof safetySessionKeySchema>;
export type SafetyTarget = z.infer<typeof safetyTargetSchema>;
export type SafetyIdentity = z.infer<typeof safetyIdentitySchema>;
export type SafetyHistoryProjection = z.infer<typeof safetyProjectionSchema>;
export type SafetyRecord = z.infer<typeof safetyRecordSchema>;
export type SafetyPage = z.infer<typeof safetyPageSchema>;
export type SafetyUpdate = z.infer<typeof safetyUpdateSchema>;
export type SafetyUnavailable = z.infer<typeof safetyUnavailableSchema>;
export type SafetyCapabilities = z.infer<typeof safetyCapabilitiesSchema>;

/** Individual review only. No principal, channel, range or standing rule input. */
export const safetyReviewBodySchema = z.strictObject({ version:z.literal(1), session:safetySessionKeySchema, occurrenceId:id,
  expectedEvidenceRevision:revision, verdict:z.literal("safe") });
export const safetyReviewReceiptSchema = z.strictObject({ version:z.literal(1), requestId:id.nullable(), operationId:id.nullable(), session:safetySessionKeySchema,
  occurrenceId:id, stage:z.enum(["prepared","verdict_committed","refused"]), verdict:z.enum(["unresolved","committed"]),
  projection:safetyProjectionSchema.nullable(), reason:text(512).nullable() });
/** receipt is immutable on replay; currentProjection is a separate live read. */
const reviewResultSchema = z.strictObject({ version:z.literal(1), receipt:safetyReviewReceiptSchema, currentProjection:safetyProjectionSchema.nullable() });
export const safetyReviewResponseSchema = z.union([reviewResultSchema,reviewResultSchema.extend({
  code:z.enum(["unauthorized","unavailable","stale_revision","not_finalized","request_conflict","request_expired","retired","capacity","recording_failed","resync_required"]),
  reason:text(512),retryable:z.literal(false),
})]);
export type SafetyReviewBody = z.infer<typeof safetyReviewBodySchema>;
export type SafetyReviewReceipt = z.infer<typeof safetyReviewReceiptSchema>;
export type SafetyReviewResponse = z.infer<typeof safetyReviewResponseSchema>;

export const clientSafetyReadSchema = z.strictObject({type:z.literal("safety_read"),requestId:id,version:z.literal(1),target:safetyTargetSchema,cursor:z.string().max(512).nullable().optional(),limit:z.number().int().min(1).max(100).optional(),includeEntries:z.literal(true).optional()});
export const clientSafetySubscribeSchema = z.strictObject({type:z.literal("safety_subscribe"),requestId:id,version:z.literal(1),identity:safetyIdentitySchema,afterRevision:revision,snapshotId:id});
export const clientSafetyUnsubscribeSchema = z.strictObject({type:z.literal("safety_unsubscribe"),version:z.literal(1)});
export const serverSafetyHistorySchema = z.strictObject({type:z.literal("safety_history"),requestId:id,page:safetyPageSchema});
export const serverSafetyUpdateSchema = z.strictObject({type:z.literal("safety_update"),update:safetyUpdateSchema});
export const serverSafetyUnavailableSchema = z.strictObject({type:z.literal("safety_unavailable"),requestId:id.optional(),...safetyUnavailableSchema.shape});
export type ClientSafetyRead = z.infer<typeof clientSafetyReadSchema>;
export type ClientSafetySubscribe = z.infer<typeof clientSafetySubscribeSchema>;
export type ClientSafetyUnsubscribe = z.infer<typeof clientSafetyUnsubscribeSchema>;
export type ServerSafetyHistory = z.infer<typeof serverSafetyHistorySchema>;
export type ServerSafetyUpdate = z.infer<typeof serverSafetyUpdateSchema>;
export type ServerSafetyUnavailable = z.infer<typeof serverSafetyUnavailableSchema>;
