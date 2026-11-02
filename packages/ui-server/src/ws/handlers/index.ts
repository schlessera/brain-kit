import type { ClientMessageHandlers } from "./context.js";
import { handleActivitySubscribe, handleActivityUnsubscribe } from "./activity.js";
import { handleAskAnswerFrame, handleAskAnswerStatusFrame, handleAskUserCancel } from "./ask.js";
import { handleCancel } from "./cancel.js";
import { handleChatMessageFrame } from "./chat-message.js";
import { handleClientHello } from "./client-hello.js";
import {
  handleConversationAudio,
  handleConversationCommit,
  handleConversationEndpoint,
  handleConversationPlayback,
  handleConversationStart,
  handleConversationStop,
} from "./conversation.js";
import { handleDialogueRead } from "./dialogue-read.js";
import { handleHandoffPrepare, handleHandoffPrepareCancel, handleHandoffStatus } from "./handoff.js";
import { handleInboxDecision, handleInboxSubscribe, handleInboxUnsubscribe } from "./inbox.js";
import { handleLocalExchange } from "./local-exchange.js";
import { handleLocationError, handleLocationResponse } from "./location.js";
import { handleMaskError, handleMaskResponse } from "./mask.js";
import { handlePing } from "./ping.js";
import { handleRetryStatus, handleRetryTurn } from "./retry.js";
import { handleScopeDecision } from "./scope-decision.js";
import { handleSessionResume } from "./session-resume.js";
import { handleToolApproval, handleToolDenial } from "./tool-permission.js";

/**
 * The client message dispatch table. Typed as `ClientMessageHandlers`, so a
 * kind added to `ClientMessage` without a handler here fails typecheck.
 */
export const CLIENT_MESSAGE_HANDLERS: ClientMessageHandlers = {
  client_hello: handleClientHello,
  chat_message: handleChatMessageFrame,
  handoff_status: handleHandoffStatus,
  handoff_prepare: handleHandoffPrepare,
  handoff_prepare_cancel: handleHandoffPrepareCancel,
  retry_status: handleRetryStatus,
  retry_turn: handleRetryTurn,
  local_exchange: handleLocalExchange,
  scope_decision: handleScopeDecision,
  ask_user_response: handleAskAnswerFrame,
  ask_user_list_response: handleAskAnswerFrame,
  ask_user_rank_response: handleAskAnswerFrame,
  ask_user_form_response: handleAskAnswerFrame,
  ask_answer_status: handleAskAnswerStatusFrame,
  ask_user_cancel: handleAskUserCancel,
  ping: handlePing,
  location_response: handleLocationResponse,
  location_error: handleLocationError,
  mask_response: handleMaskResponse,
  mask_error: handleMaskError,
  tool_approval: handleToolApproval,
  tool_denial: handleToolDenial,
  cancel: handleCancel,
  inbox_resolve: handleInboxDecision,
  inbox_snooze: handleInboxDecision,
  inbox_subscribe: handleInboxSubscribe,
  inbox_unsubscribe: handleInboxUnsubscribe,
  activity_subscribe: handleActivitySubscribe,
  activity_unsubscribe: handleActivityUnsubscribe,
  conversation_start: handleConversationStart,
  conversation_audio: handleConversationAudio,
  conversation_endpoint: handleConversationEndpoint,
  conversation_commit: handleConversationCommit,
  conversation_playback: handleConversationPlayback,
  conversation_stop: handleConversationStop,
  dialogue_read: handleDialogueRead,
  session_resume: handleSessionResume,
};
