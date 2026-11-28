/**
 * Every exported `*Schema` of `schemas.ts` against the protocol type it
 * validates, in both directions (#4825). `satisfies z.ZodType<T>` proves
 * assignability only; `SchemaEqualsProtocol` also catches an optional key the
 * schema forgot or added. The map is keyed by the module's own exports, so a
 * newly exported schema without an entry fails `tsc --noEmit` here.
 */
import type { z } from "zod";
import type * as P from "../src/protocol.js";
import type * as S from "../src/schemas.js";
import type { Assert, DeepShape, Equal, SchemaEqualsProtocol } from "./type-equality.js";

type ExportedSchemaName = Extract<keyof typeof S, `${string}Schema`>;

type KeysOf<U> = U extends unknown ? keyof U : never;
type ValueOf<U, K extends PropertyKey> = U extends unknown ? K extends keyof U ? Exclude<U[K], undefined> : never : never;
type RequiredIn<U, K extends PropertyKey> = U extends unknown ? K extends keyof U ? {} extends Pick<U, K> ? false : true : false : never;
/** A union of object types as one object: a key is optional unless every member requires it. */
type Merged<U> = { [K in KeysOf<U> as false extends RequiredIn<U, K> ? never : K]: ValueOf<U, K> }
  & { [K in KeysOf<U> as false extends RequiredIn<U, K> ? K : never]?: ValueOf<U, K> };

/** Each schema and the type it validates; compared with `z.infer`. */
interface SchemaProtocol {
  clientEnvironmentSchema: P.ClientEnvironment;
  clientHelloSchema: P.ClientHello;
  messageSourceSchema: P.MessageSource;
  localExchangeSchema: P.LocalExchange;
  clientLocalExchangeSchema: P.ClientLocalExchange;
  handoffRequestSchema: P.HandoffRequest;
  clientHandoffPrepareSchema: P.ClientHandoffPrepare;
  clientHandoffPrepareCancelSchema: P.ClientHandoffPrepareCancel;
  clientHandoffStatusSchema: P.ClientHandoffStatus;
  draftRefSchema: P.DraftRef;
  clientChatMessageSchema: P.ClientChatMessage;
  clientToolApprovalSchema: P.ClientToolApproval;
  clientToolDenialSchema: P.ClientToolDenial;
  clientCancelSchema: P.ClientCancelRequest;
  clientSessionResumeSchema: P.ClientSessionResume;
  clientAskUserResponseSchema: P.ClientAskUserResponse;
  clientAskUserCancelSchema: P.ClientAskUserCancel;
  clientAskUserListResponseSchema: P.ClientAskUserListResponse;
  clientAskUserFormResponseSchema: P.ClientAskUserFormResponse;
  clientAskUserRankResponseSchema: P.ClientAskUserRankResponse;
  clientAskAnswerStatusSchema: P.ClientAskAnswerStatus;
  clientPingSchema: P.ClientPing;
  clientLocationResponseSchema: P.ClientLocationResponse;
  clientLocationErrorSchema: P.ClientLocationError;
  clientMaskResponseSchema: P.ClientMaskResponse;
  clientMaskErrorSchema: P.ClientMaskError;
  clientMarkupErrorSchema: P.ClientMarkupError;
  clientActivitySubscribeSchema: P.ClientActivitySubscribe;
  clientActivityUnsubscribeSchema: P.ClientActivityUnsubscribe;
  clientRetryTurnSchema: P.ClientRetryTurn;
  clientRetryStatusSchema: P.ClientRetryStatus;
  inboxViewSchema: P.InboxView;
  inboxQueueStatusSchema: P.InboxQueueStatus;
  inboxActionStatusSchema: P.InboxActionStatus;
  inboxDismissReasonSchema: P.InboxDismissReason;
  inboxOperationSchema: P.InboxOperation;
  inboxWorkPayloadSchema: P.InboxWorkPayload;
  hygieneInputSchema: P.HygieneInput;
  hygieneDiffSchema: P.HygieneDiff;
  hygieneEffectSchema: P.HygieneEffect;
  hygieneMediaRefusalSchema: P.HygieneMediaRefusal;
  hygieneMediaMatchesSchema: P.HygieneMediaMatches;
  hygieneMediaProbeSchema: P.HygieneMediaProbe;
  hygieneMediaPlanSchema: P.HygieneMediaPlan;
  hygieneMediaReceiptSchema: P.HygieneMediaReceipt;
  /** No interface of its own: the type it validates is `HygieneAction.outcome`. */
  hygieneOutcomeSchema: NonNullable<P.HygieneAction["outcome"]>;
  hygieneActionSchema: P.HygieneAction;
  hygieneReviewCommandSchema: P.HygieneReviewCommand;
  hygieneReviewMediaUndoCommandSchema: P.HygieneReviewMediaUndoCommand;
  hygieneReviewRequestSchema: P.HygieneReviewRequest;
  hygienePreviewRequestSchema: P.HygienePreviewRequest;
  resolutionEffectSchema: P.ResolutionEffect;
  v1ResolutionEffectSchema: P.V1ResolutionEffect;
  inboxOptionSchema: P.InboxOption;
  clientInboxResolveSchema: P.ClientInboxResolve;
  clientInboxSnoozeSchema: P.ClientInboxSnooze;
  clientInboxSubscribeSchema: P.ClientInboxSubscribe;
  clientInboxUnsubscribeSchema: P.ClientInboxUnsubscribe;
  /** A bounded integer; the protocol carries sample rates as `number`. */
  conversationSampleRateSchema: number;
  clientDialogueReadSchema: P.ClientDialogueRead;
  clientConversationStartSchema: P.ClientConversationStart;
  clientConversationAudioSchema: P.ClientConversationAudio;
  clientConversationEndpointSchema: P.ClientConversationEndpoint;
  clientConversationCommitSchema: P.ClientConversationCommit;
  clientConversationPlaybackSchema: P.ClientConversationPlayback;
  clientConversationStopSchema: P.ClientConversationStop;
  clientTurnTimingSchema: P.ClientTurnTiming;
  clientMessageSchema: P.ClientMessage;
  messageBlockSchema: P.MessageBlock;
  turnBudgetReceiptSchema: P.TurnBudgetReceipt;
  turnScopeSummarySchema: P.TurnScopeSummary;
  turnJournalSummarySchema: P.TurnJournalSummary;
  sessionDraftLimitsSchema: P.SessionDraftLimits;
  attachmentLimitsSchema: P.AttachmentLimits;
  serverHelloSchema: P.ServerHello;
  draftSummarySchema: P.DraftSummary;
  draftListResponseSchema: P.DraftListResponse;
  draftAttachmentSchema: P.DraftAttachment;
  draftSchema: P.Draft;
  draftSaveResponseSchema: P.DraftSaveResponse;
  sessionRecoverySchema: P.SessionRecovery;
  serverTextDeltaSchema: P.ServerTextDelta;
  serverThinkingDeltaSchema: P.ServerThinkingDelta;
  serverToolUseStartSchema: P.ServerToolUseStart;
  serverToolInputDeltaSchema: P.ServerToolInputDelta;
  serverToolUseCompleteSchema: P.ServerToolUseComplete;
  serverToolResultSchema: P.ServerToolResult;
  approvalDisplaySchema: P.ApprovalDisplay;
  networkApprovalScopeSchema: P.NetworkApprovalScope;
  toolResolutionExpiryCauseSchema: P.ToolResolutionExpiryCause;
  networkApprovalOfferSchema: P.NetworkApprovalOffer;
  networkGrantViewSchema: P.NetworkGrantView;
  sessionNetworkGrantsResponseSchema: P.SessionNetworkGrantsResponse;
  serverNetworkGrantsSchema: P.ServerNetworkGrants;
  serverToolApprovalRequestSchema: P.ServerToolApprovalRequest;
  stateRoomObservationSchema: P.StateRoomObservation;
  serverResultSchema: P.ServerResultMessage;
  serverErrorSchema: P.ServerError;
  serverStatusSchema: P.ServerStatus;
  sessionWorkerProfileSchema: P.SessionWorkerProfile;
  serverSessionInfoSchema: P.ServerSessionInfo;
  serverSessionHistorySchema: P.ServerSessionHistory;
  serverAskUserRequestSchema: P.ServerAskUserRequest;
  serverAskUserListRequestSchema: P.ServerAskUserListRequest;
  serverAskUserFormRequestSchema: P.ServerAskUserFormRequest;
  serverAskUserRankRequestSchema: P.ServerAskUserRankRequest;
  serverLocationRequestSchema: P.ServerLocationRequest;
  serverMaskRequestSchema: P.ServerMaskRequest;
  serverMarkupRequestSchema: P.ServerMarkupRequest;
  serverActivitySnapshotSchema: P.ServerActivitySnapshot;
  serverActivityDeltaSchema: P.ServerActivityDelta;
  serverMessageBlocksSchema: P.ServerMessageBlocks;
  serverMessageLinksSchema: P.ServerMessageLinks;
  serverLocalExchangeResultSchema: P.ServerLocalExchangeResult;
  serverRetryReceiptSchema: P.ServerRetryReceipt;
  serverHandoffDraftSchema: P.ServerHandoffDraft;
  serverHandoffReceiptSchema: P.ServerHandoffReceipt;
  serverAskAnswerReceiptSchema: P.ServerAskAnswerReceipt;
  serverPongSchema: P.ServerPong;
  inboxThreadSchema: P.InboxThread;
  inboxItemBaseSchema: P.InboxItemBase;
  inboxQueueItemSchema: P.InboxQueueItem;
  inboxActionItemSchema: P.InboxActionItem;
  hygieneWorktreeDetailsReadSchema: P.HygieneWorktreeDetailsRead;
  inboxItemSchema: P.InboxItem;
  inboxChangeSchema: P.InboxChange;
  inboxSnapshotSchema: P.InboxSnapshot;
  inboxDeltaSchema: P.InboxDelta;
  conversationEvidenceSchema: P.ConversationEvidence;
  conversationCapabilitiesSchema: P.ConversationCapabilities;
  conversationDisclosureSchema: P.ConversationDisclosure;
  conversationVoiceSchema: P.ConversationVoice;
  conversationProfileSchema: P.ConversationProfile;
  /** Its refinement (unique `providerId`) narrows no static type: the unrefined shape is what `z.infer` gives. */
  conversationProfilesSchema: P.ConversationProfile[];
  liveDefaultSchema: P.LiveDefault;
  serverLiveSettingsSchema: P.ServerLiveSettings;
  voiceLiveSettingsSchema: P.VoiceLiveSettings;
  conversationPersonaRefSchema: P.ConversationPersonaRef;
  livePersonaSummarySchema: P.LivePersonaSummary;
  livePersonaSchema: P.LivePersona;
  livePersonaListResponseSchema: P.LivePersonaListResponse;
  livePersonaProviderStatusSchema: P.LivePersonaProviderStatus;
  livePersonaStatusSchema: P.LivePersonaStatus;
  voiceSettingsResponseSchema: P.VoiceSettingsResponse;
  serverLivePersonaSchema: P.ServerLivePersona;
  conversationAudioFormatSchema: P.ConversationAudioFormat;
  conversationWireEventSchema: P.ConversationWireEvent;
  /**
   * Kept as `as z.ZodType<…>`: its refinement narrows one flat object to the
   * provenance union, which `satisfies` cannot express. Its unrefined shape
   * is the frame's, asserted under `serverConversationWorkSchema` below.
   */
  conversationWorkReceiptSchema: P.ConversationWorkReceipt;
  conversationOutputRecordSchema: P.ConversationOutputRecord;
  serverConversationOutputSchema: P.ServerConversationOutput;
  conversationLimitsSchema: P.ConversationLimits;
  /**
   * Kept as `as z.ZodType<…>`: `satisfies` would publish the inferred zod type
   * in place of `ZodType<DialogueEvidence>`. The entry holds its export; the
   * union inside the cast is compared where it is declared, in `schemas.ts`
   * (`_DialogueEvidenceParity`, #4896).
   */
  dialogueEvidenceSchema: P.DialogueEvidence;
  dialogueRecordSchema: P.DialogueRecord;
  dialoguePageSchema: P.DialoguePage;
  serverDialogueHistorySchema: P.ServerDialogueHistory;
  serverConversationOpenedSchema: P.ServerConversationOpened;
  serverConversationClosedSchema: P.ServerConversationClosed;
  serverConversationEventSchema: P.ServerConversationEvent;
  serverConversationPermissionSchema: P.ServerConversationPermission;
  serverToolResolutionSchema: P.ServerToolResolution;
  queuedFollowUpViewSchema: P.QueuedFollowUpView;
  serverSessionQueueSchema: P.ServerSessionQueue;
  serverChatRetiredSchema: P.ServerChatRetired;
  sessionAttachmentReadsResponseSchema: P.SessionAttachmentReadsResponse;
  serverAttachmentReadSchema: P.ServerAttachmentRead;
  serverUsageSchema: P.ServerUsage;
  serverTurnJournalSchema: P.ServerTurnJournal;
  serverMessageSchema: P.ServerMessage;
  queueAddRequestSchema: P.QueueAddRequest;
  queueAddResultSchema: P.QueueAddResult;
}

/**
 * A schema whose output is not its wire shape, compared on the shape it
 * accepts: a `.default()` makes a key required only after parsing, and a
 * `.transform()` returns the protocol type by construction.
 */
interface InputProtocol {
  /** `.default()` fills counters a stored row predates; the type keeps them optional, as the wire does. */
  hygieneReviewStateSchema: P.HygieneReviewState;
  hygieneReviewReadSchema: P.HygieneReviewRead;
  /**
   * A flat object a refinement narrows to the provenance union, then a
   * transform re-types as the frame: compared with that union merged into
   * one object. Its shape is `conversationWorkReceiptSchema`'s too.
   */
  serverConversationWorkSchema: Merged<P.ServerConversationWork>;
}

/** Re-exported from the module that defines them; their parity is outside this file (#4825 scope). */
interface ReExported {
  safetyFutureStatusSchema: true; safetyFuturePrepareSchema: true; safetyFutureCommitSchema: true; safetyFuturePreparedSchema: true;
  safetyFutureResultSchema: true; safetyProjectionSchema: true; safetyReviewBodySchema: true; safetyReviewReceiptSchema: true;
  safetyReviewResponseSchema: true; safetySessionKeySchema: true; safetyPageSchema: true; safetyUpdateSchema: true;
  safetyCapabilitiesSchema: true; attachmentFileSchema: true; sharedFileMetaSchema: true; TrustRuleSchema: true; TrustedSourcesSchema: true;
}

type Covered = keyof SchemaProtocol | keyof InputProtocol | keyof ReExported;
/** A schema exported without an entry. Must be `never`. */
type Unmapped = Exclude<ExportedSchemaName, Covered>;
/** An entry for a schema that is not exported. Must be `never`. */
type Stale = Exclude<Covered, ExportedSchemaName>;

type InputEqualsProtocol<Schema extends z.ZodType, Protocol> = Equal<DeepShape<z.input<Schema>>, DeepShape<Protocol>>;
/** Every entry whose schema and type differ in either direction. Must be `never`. */
type Drifted =
  | { [K in keyof SchemaProtocol]: SchemaEqualsProtocol<(typeof S)[K], SchemaProtocol[K]> extends true ? never : K }[keyof SchemaProtocol]
  | { [K in keyof InputProtocol]: InputEqualsProtocol<(typeof S)[K], InputProtocol[K]> extends true ? never : K }[keyof InputProtocol];

export type SchemaParityChecks = [
  Assert<Equal<Unmapped, never>>,
  Assert<Equal<Stale, never>>,
  Assert<Equal<Drifted, never>>,
];
