import { handleAskAnswer, handleAskAnswerStatus } from "../ask-answers.js";
import { turnIdMatches, type ClientMessageHandler } from "./context.js";

type AskAnswerType =
  | "ask_user_response"
  | "ask_user_list_response"
  | "ask_user_rank_response"
  | "ask_user_form_response";

/** Every ask kind answers through one path; see ask-answers.ts. */
export const handleAskAnswerFrame: ClientMessageHandler<AskAnswerType> = ({ host, ws, connection }, msg) => {
  handleAskAnswer(host, ws, msg, connection.authorization.principalId);
};

export const handleAskAnswerStatusFrame: ClientMessageHandler<"ask_answer_status"> = ({ host, ws, connection }, msg) => {
  handleAskAnswerStatus(host, ws, msg, connection.authorization.principalId);
};

export const handleAskUserCancel: ClientMessageHandler<"ask_user_cancel"> = ({ host, connection, requireEcho }, msg) => {
  const { coordinator } = host;
  // Dismisses any ask kind: the ids share one space.
  const pending = coordinator.pendingAsk(msg.requestId)?.entry;
  if (pending && turnIdMatches(pending, msg.turnId, requireEcho)) {
    // Recorded as `cancelled`, so a queued answer arriving later is told
    // the question was dismissed instead of meeting silence.
    coordinator.cancelAsk(msg.requestId);
    pending.turn.recorder?.recordCancellation(
      connection.authorization.principalId,
      "ask_user"
    );
    pending.reject(new Error(msg.reason || "User cancelled the question"));
  }
};
