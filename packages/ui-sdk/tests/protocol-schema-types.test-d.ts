import type { z } from "zod";

import type {
  ClientActivitySubscribe,
  ClientActivityUnsubscribe,
  ClientAskUserCancel,
  ClientAskUserResponse,
  ClientCancelRequest,
  ClientChatMessage,
  ClientHello,
  ClientLocationError,
  ClientLocationResponse,
  ClientMaskError,
  ClientMaskResponse,
  ClientSessionResume,
  ClientToolApproval,
  ClientToolDenial,
  ServerActivityDelta,
  ServerActivitySnapshot,
  ServerAskUserRequest,
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
  clientCancelSchema,
  clientChatMessageSchema,
  clientHelloSchema,
  clientLocationErrorSchema,
  clientLocationResponseSchema,
  clientMaskErrorSchema,
  clientMaskResponseSchema,
  clientSessionResumeSchema,
  clientToolApprovalSchema,
  clientToolDenialSchema,
  serverActivityDeltaSchema,
  serverActivitySnapshotSchema,
  serverAskUserRequestSchema,
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

/** Remove z.looseObject's catch-all index signature without losing named keys. */
type StripIndexSignature<T> = {
  [K in keyof T as string extends K
    ? never
    : number extends K
      ? never
      : symbol extends K
        ? never
        : K]: T[K];
};

/**
 * Canonical recursive shape used for comparison. Arrays recurse through their
 * elements. Objects with named keys lose z.looseObject's catch-all signature;
 * pure record types retain their index signature and value type.
 */
type DeepShape<T> = T extends readonly unknown[]
  ? // Homomorphic for tuples AND variable-length arrays, which is what keeps
    // the readonly modifier: rewriting an array as `Array<DeepShape<...>>`
    // would erase it, and `readonly AskUserOption[]` versus `AskUserOption[]`
    // would then compare equal.
    { [K in keyof T]: DeepShape<T[K]> }
  : T extends object
    ? keyof StripIndexSignature<T> extends never
      ? { [K in keyof T]: DeepShape<T[K]> }
      : {
          [K in keyof StripIndexSignature<T>]: DeepShape<StripIndexSignature<T>[K]>;
        }
    : T;

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2
    ? (<T>() => T extends Right ? 1 : 2) extends <T>() => T extends Left ? 1 : 2
      ? true
      : false
    : false;

type SchemaEqualsProtocol<Schema extends z.ZodType, Protocol> = Equal<
  DeepShape<z.infer<Schema>>,
  DeepShape<Protocol>
>;

type Assert<Condition extends true> = Condition;

// Client -> server: all 14 frames.
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

// Server -> client: all 18 frames.
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
  ClientAskUserCancelMatches,
  ClientLocationResponseMatches,
  ClientLocationErrorMatches,
  ClientMaskResponseMatches,
  ClientMaskErrorMatches,
  ClientActivitySubscribeMatches,
  ClientActivityUnsubscribeMatches,
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
  ServerLocationRequestMatches,
  ServerMaskRequestMatches,
  ServerActivitySnapshotMatches,
  ServerActivityDeltaMatches,
  MissingNestedMemberMustFail,
  ReadonlyArrayDriftMustFail,
];
