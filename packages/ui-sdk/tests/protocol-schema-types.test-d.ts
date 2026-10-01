import type {
  ClientInboxResolve,
  ClientInboxSnooze,
  ClientInboxSubscribe,
  ClientInboxUnsubscribe,
  InboxView,
  InboxQueueStatus,
  InboxActionStatus,
  InboxDismissReason,
  InboxThread,
  InboxOperation,
  InboxWorkPayload,
  ResolutionEffect,
  V1ResolutionEffect,
  InboxOption,
  InboxItemBase,
  InboxQueueItem,
  InboxActionItem,
  InboxItem,
  InboxChange,
  InboxSnapshot,
  InboxDelta,
} from "../src/protocol.js";
import {
  clientInboxResolveSchema,
  clientInboxSnoozeSchema,
  clientInboxSubscribeSchema,
  clientInboxUnsubscribeSchema,
  inboxViewSchema,
  inboxQueueStatusSchema,
  inboxActionStatusSchema,
  inboxDismissReasonSchema,
  inboxThreadSchema,
  inboxOperationSchema,
  inboxWorkPayloadSchema,
  resolutionEffectSchema,
  v1ResolutionEffectSchema,
  inboxOptionSchema,
  inboxItemBaseSchema,
  inboxQueueItemSchema,
  inboxActionItemSchema,
  inboxItemSchema,
  inboxChangeSchema,
  inboxSnapshotSchema,
  inboxDeltaSchema,
} from "../src/schemas.js";
import type {
  ClientActivitySubscribe,
  ClientActivityUnsubscribe,
  ClientAskUserCancel,
  ClientAskUserResponse,
  ClientAskUserListResponse,
  ClientAskUserRankResponse,
  ClientCancelRequest,
  ClientChatMessage,
  ClientHello,
  ClientLocalExchange,
  LocalExchange,
  ServerLocalExchangeResult,
  ClientLocationError,
  ClientLocationResponse,
  ClientMaskError,
  ClientMaskResponse,
  ClientSessionResume,
  ClientToolApproval,
  ClientToolDenial,
  ServerActivityDelta,
  ServerMessageBlocks,
  MessageBlock,
  ServerActivitySnapshot,
  ServerAskUserRequest,
  ServerAskUserListRequest,
  ServerAskUserRankRequest,
  ServerError,
  ServerHello,
  ServerLocationRequest,
  ServerMaskRequest,
  ServerResultMessage,
  ServerSessionHistory,
  ServerSessionInfo,
  ServerStatus,
  ServerTextDelta,
  ServerThinkingDelta,
  ServerToolApprovalRequest,
  ServerToolInputDelta,
  ServerToolResult,
  ServerToolUseComplete,
  ServerToolUseStart,
} from "../src/protocol.js";
import {
  clientActivitySubscribeSchema,
  clientActivityUnsubscribeSchema,
  clientAskUserCancelSchema,
  clientAskUserResponseSchema,
  clientAskUserListResponseSchema,
  clientAskUserRankResponseSchema,
  clientCancelSchema,
  clientChatMessageSchema,
  clientHelloSchema,
  clientLocalExchangeSchema,
  localExchangeSchema,
  serverLocalExchangeResultSchema,
  clientLocationErrorSchema,
  clientLocationResponseSchema,
  clientMaskErrorSchema,
  clientMaskResponseSchema,
  clientSessionResumeSchema,
  clientToolApprovalSchema,
  clientToolDenialSchema,
  serverActivityDeltaSchema,
  serverMessageBlocksSchema,
  messageBlockSchema,
  serverActivitySnapshotSchema,
  serverAskUserRequestSchema,
  serverAskUserListRequestSchema,
  serverAskUserRankRequestSchema,
  serverErrorSchema,
  serverHelloSchema,
  serverLocationRequestSchema,
  serverMaskRequestSchema,
  serverResultSchema,
  serverSessionHistorySchema,
  serverSessionInfoSchema,
  serverStatusSchema,
  serverTextDeltaSchema,
  serverThinkingDeltaSchema,
  serverToolApprovalRequestSchema,
  serverToolInputDeltaSchema,
  serverToolResultSchema,
  serverToolUseCompleteSchema,
  serverToolUseStartSchema,
} from "../src/schemas.js";

import type {
  Assert,
  SchemaEqualsProtocol,
} from "./type-equality.js";


type ClientAskUserRankResponseMatches = Assert<SchemaEqualsProtocol<typeof clientAskUserRankResponseSchema, ClientAskUserRankResponse>>;
type ServerAskUserRankRequestMatches = Assert<SchemaEqualsProtocol<typeof serverAskUserRankRequestSchema, ServerAskUserRankRequest>>;
// Client -> server: all 15 frames.
type ClientHelloMatches = Assert<SchemaEqualsProtocol<typeof clientHelloSchema, ClientHello>>;
type ClientChatMessageMatches = Assert<
  SchemaEqualsProtocol<typeof clientChatMessageSchema, ClientChatMessage>
>;
type ClientToolApprovalMatches = Assert<
  SchemaEqualsProtocol<typeof clientToolApprovalSchema, ClientToolApproval>
>;
type ClientToolDenialMatches = Assert<
  SchemaEqualsProtocol<typeof clientToolDenialSchema, ClientToolDenial>
>;
type ClientCancelMatches = Assert<
  SchemaEqualsProtocol<typeof clientCancelSchema, ClientCancelRequest>
>;
type ClientSessionResumeMatches = Assert<
  SchemaEqualsProtocol<typeof clientSessionResumeSchema, ClientSessionResume>
>;
type ClientAskUserResponseMatches = Assert<
  SchemaEqualsProtocol<typeof clientAskUserResponseSchema, ClientAskUserResponse>
>;
type ClientAskUserListResponseMatches = Assert<
  SchemaEqualsProtocol<typeof clientAskUserListResponseSchema, ClientAskUserListResponse>
>;
type ClientAskUserCancelMatches = Assert<
  SchemaEqualsProtocol<typeof clientAskUserCancelSchema, ClientAskUserCancel>
>;
type ClientLocationResponseMatches = Assert<
  SchemaEqualsProtocol<typeof clientLocationResponseSchema, ClientLocationResponse>
>;
type ClientLocationErrorMatches = Assert<
  SchemaEqualsProtocol<typeof clientLocationErrorSchema, ClientLocationError>
>;
type ClientMaskResponseMatches = Assert<
  SchemaEqualsProtocol<typeof clientMaskResponseSchema, ClientMaskResponse>
>;
type ClientMaskErrorMatches = Assert<
  SchemaEqualsProtocol<typeof clientMaskErrorSchema, ClientMaskError>
>;
type ClientActivitySubscribeMatches = Assert<
  SchemaEqualsProtocol<typeof clientActivitySubscribeSchema, ClientActivitySubscribe>
>;
type ClientActivityUnsubscribeMatches = Assert<
  SchemaEqualsProtocol<typeof clientActivityUnsubscribeSchema, ClientActivityUnsubscribe>
>;
type ClientLocalExchangeMatches = Assert<
  SchemaEqualsProtocol<typeof clientLocalExchangeSchema, ClientLocalExchange>
>;
type LocalExchangeMatches = Assert<SchemaEqualsProtocol<typeof localExchangeSchema, LocalExchange>>;

// Server -> client: all 20 frames.
type ServerHelloMatches = Assert<SchemaEqualsProtocol<typeof serverHelloSchema, ServerHello>>;
type ServerTextDeltaMatches = Assert<
  SchemaEqualsProtocol<typeof serverTextDeltaSchema, ServerTextDelta>
>;
type ServerThinkingDeltaMatches = Assert<
  SchemaEqualsProtocol<typeof serverThinkingDeltaSchema, ServerThinkingDelta>
>;
type ServerToolUseStartMatches = Assert<
  SchemaEqualsProtocol<typeof serverToolUseStartSchema, ServerToolUseStart>
>;
type ServerToolInputDeltaMatches = Assert<
  SchemaEqualsProtocol<typeof serverToolInputDeltaSchema, ServerToolInputDelta>
>;
type ServerToolUseCompleteMatches = Assert<
  SchemaEqualsProtocol<typeof serverToolUseCompleteSchema, ServerToolUseComplete>
>;
type ServerToolResultMatches = Assert<
  SchemaEqualsProtocol<typeof serverToolResultSchema, ServerToolResult>
>;
type ServerToolApprovalRequestMatches = Assert<
  SchemaEqualsProtocol<typeof serverToolApprovalRequestSchema, ServerToolApprovalRequest>
>;
type ServerResultMatches = Assert<
  SchemaEqualsProtocol<typeof serverResultSchema, ServerResultMessage>
>;
type ServerErrorMatches = Assert<SchemaEqualsProtocol<typeof serverErrorSchema, ServerError>>;
type ServerStatusMatches = Assert<SchemaEqualsProtocol<typeof serverStatusSchema, ServerStatus>>;
type ServerSessionInfoMatches = Assert<
  SchemaEqualsProtocol<typeof serverSessionInfoSchema, ServerSessionInfo>
>;
type ServerSessionHistoryMatches = Assert<
  SchemaEqualsProtocol<typeof serverSessionHistorySchema, ServerSessionHistory>
>;
type ServerAskUserRequestMatches = Assert<
  SchemaEqualsProtocol<typeof serverAskUserRequestSchema, ServerAskUserRequest>
>;
type ServerAskUserListRequestMatches = Assert<
  SchemaEqualsProtocol<typeof serverAskUserListRequestSchema, ServerAskUserListRequest>
>;
type ServerLocationRequestMatches = Assert<
  SchemaEqualsProtocol<typeof serverLocationRequestSchema, ServerLocationRequest>
>;
type ServerMaskRequestMatches = Assert<
  SchemaEqualsProtocol<typeof serverMaskRequestSchema, ServerMaskRequest>
>;
type ServerActivitySnapshotMatches = Assert<
  SchemaEqualsProtocol<typeof serverActivitySnapshotSchema, ServerActivitySnapshot>
>;
type ServerActivityDeltaMatches = Assert<
  SchemaEqualsProtocol<typeof serverActivityDeltaSchema, ServerActivityDelta>
>;
type ServerMessageBlocksMatches = Assert<
  SchemaEqualsProtocol<typeof serverMessageBlocksSchema, ServerMessageBlocks>
>;
type ServerLocalExchangeResultMatches = Assert<
  SchemaEqualsProtocol<typeof serverLocalExchangeResultSchema, ServerLocalExchangeResult>
>;
type MessageBlockMatches = Assert<SchemaEqualsProtocol<typeof messageBlockSchema, MessageBlock>>;

// Negative fixture: removing a nested optional member must make the guard fail.
type AskUserRequestWithoutPreview = {
  type: "ask_user_request";
  requestId: string;
  questions: Array<{
    question: string;
    header: string;
    multiSelect: boolean;
    options: Array<{
      label: string;
      description: string;
    }>;
  }>;
  sessionId?: string;
  turnId?: string;
};

type MissingNestedMemberMustFail = Assert<
  // @ts-expect-error -- proves nested key-set/optionality drift is rejected.
  SchemaEqualsProtocol<typeof serverAskUserRequestSchema, AskUserRequestWithoutPreview>
>;

/**
 * The same protocol interface with one array made readonly. The schema infers a
 * mutable array, so this must be rejected — an array whose element type matches
 * is not the same type if its mutability differs.
 */
type AskUserRequestReadonlyOptions = {
  type: "ask_user_request";
  requestId: string;
  questions: Array<{
    question: string;
    header: string;
    multiSelect: boolean;
    options: ReadonlyArray<{
      label: string;
      description: string;
      preview?: string;
    }>;
  }>;
  sessionId?: string;
  turnId?: string;
};

type ReadonlyArrayDriftMustFail = Assert<
  // @ts-expect-error -- proves shared-key value-type drift (mutability) is rejected.
  SchemaEqualsProtocol<typeof serverAskUserRequestSchema, AskUserRequestReadonlyOptions>
>;

/** Keep every assertion live under the repository's no-unused-vars lint rule. */
export type ProtocolSchemaAssertions = [
  ClientHelloMatches,
  ClientChatMessageMatches,
  ClientToolApprovalMatches,
  ClientToolDenialMatches,
  ClientCancelMatches,
  ClientSessionResumeMatches,
  ClientAskUserResponseMatches,
  ClientAskUserListResponseMatches,
  ClientAskUserRankResponseMatches,
  ClientAskUserCancelMatches,
  ClientLocationResponseMatches,
  ClientLocationErrorMatches,
  ClientMaskResponseMatches,
  ClientMaskErrorMatches,
  ClientActivitySubscribeMatches,
  ClientActivityUnsubscribeMatches,
  ClientLocalExchangeMatches,
  LocalExchangeMatches,
  ServerHelloMatches,
  ServerTextDeltaMatches,
  ServerThinkingDeltaMatches,
  ServerToolUseStartMatches,
  ServerToolInputDeltaMatches,
  ServerToolUseCompleteMatches,
  ServerToolResultMatches,
  ServerToolApprovalRequestMatches,
  ServerResultMatches,
  ServerErrorMatches,
  ServerStatusMatches,
  ServerSessionInfoMatches,
  ServerSessionHistoryMatches,
  ServerAskUserRequestMatches,
  ServerAskUserListRequestMatches,
  ServerAskUserRankRequestMatches,
  ServerLocationRequestMatches,
  ServerMaskRequestMatches,
  ServerActivitySnapshotMatches,
  ServerActivityDeltaMatches,
  ServerMessageBlocksMatches,
  ServerLocalExchangeResultMatches,
  MessageBlockMatches,
  MissingNestedMemberMustFail,
  ReadonlyArrayDriftMustFail,
];

// Durable public shapes: recursive key/optionality/value parity, not only assignability.
type ClientInboxResolveMatches = Assert<SchemaEqualsProtocol<typeof clientInboxResolveSchema, ClientInboxResolve>>;
type ClientInboxSnoozeMatches = Assert<SchemaEqualsProtocol<typeof clientInboxSnoozeSchema, ClientInboxSnooze>>;
type ClientInboxSubscribeMatches = Assert<SchemaEqualsProtocol<typeof clientInboxSubscribeSchema, ClientInboxSubscribe>>;
type ClientInboxUnsubscribeMatches = Assert<SchemaEqualsProtocol<typeof clientInboxUnsubscribeSchema, ClientInboxUnsubscribe>>;
type InboxViewMatches = Assert<SchemaEqualsProtocol<typeof inboxViewSchema, InboxView>>;
type InboxQueueStatusMatches = Assert<SchemaEqualsProtocol<typeof inboxQueueStatusSchema, InboxQueueStatus>>;
type InboxActionStatusMatches = Assert<SchemaEqualsProtocol<typeof inboxActionStatusSchema, InboxActionStatus>>;
type InboxDismissReasonMatches = Assert<SchemaEqualsProtocol<typeof inboxDismissReasonSchema, InboxDismissReason>>;
type InboxThreadMatches = Assert<SchemaEqualsProtocol<typeof inboxThreadSchema, InboxThread>>;
type InboxOperationMatches = Assert<SchemaEqualsProtocol<typeof inboxOperationSchema, InboxOperation>>;
type InboxWorkPayloadMatches = Assert<SchemaEqualsProtocol<typeof inboxWorkPayloadSchema, InboxWorkPayload>>;
type ResolutionEffectMatches = Assert<SchemaEqualsProtocol<typeof resolutionEffectSchema, ResolutionEffect>>;
type V1ResolutionEffectMatches = Assert<SchemaEqualsProtocol<typeof v1ResolutionEffectSchema, V1ResolutionEffect>>;
type InboxOptionMatches = Assert<SchemaEqualsProtocol<typeof inboxOptionSchema, InboxOption>>;
type InboxItemBaseMatches = Assert<SchemaEqualsProtocol<typeof inboxItemBaseSchema, InboxItemBase>>;
type InboxQueueItemMatches = Assert<SchemaEqualsProtocol<typeof inboxQueueItemSchema, InboxQueueItem>>;
type InboxActionItemMatches = Assert<SchemaEqualsProtocol<typeof inboxActionItemSchema, InboxActionItem>>;
type InboxItemMatches = Assert<SchemaEqualsProtocol<typeof inboxItemSchema, InboxItem>>;
type InboxChangeMatches = Assert<SchemaEqualsProtocol<typeof inboxChangeSchema, InboxChange>>;
type InboxSnapshotMatches = Assert<SchemaEqualsProtocol<typeof inboxSnapshotSchema, InboxSnapshot>>;
type InboxDeltaMatches = Assert<SchemaEqualsProtocol<typeof inboxDeltaSchema, InboxDelta>>;

export type DurableInboxChecks = [
  ClientInboxResolveMatches,
  ClientInboxSnoozeMatches,
  ClientInboxSubscribeMatches,
  ClientInboxUnsubscribeMatches,
  InboxViewMatches,
  InboxQueueStatusMatches,
  InboxActionStatusMatches,
  InboxDismissReasonMatches,
  InboxThreadMatches,
  InboxOperationMatches,
  InboxWorkPayloadMatches,
  ResolutionEffectMatches,
  V1ResolutionEffectMatches,
  InboxOptionMatches,
  InboxItemBaseMatches,
  InboxQueueItemMatches,
  InboxActionItemMatches,
  InboxItemMatches,
  InboxChangeMatches,
  InboxSnapshotMatches,
  InboxDeltaMatches,
];
