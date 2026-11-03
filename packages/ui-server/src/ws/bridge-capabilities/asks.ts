import type { AskUserFormResult, AskUserListResult, AskUserRankResult, AskUserResult } from "@schlessera/brain-ui-sdk/server";
import { askUserFormSpec } from "@schlessera/brain-ui-sdk/internal/client";
import { withTurnScope } from "../frames.js";
import type { BridgeContext, BridgeSlice } from "./context.js";

/**
 * The four ask-user kinds. They share one request-id space: a single
 * `ask_user_cancel` dismisses any of them, so an id pending as one kind must
 * not open as another.
 */
export function createAsks(ctx: BridgeContext): BridgeSlice<"askUser" | "askUserList" | "askUserRank" | "askUserFormLimits" | "askUserForm"> {
  const { host, turn, turnId } = ctx;
  const { coordinator } = host;
  return {
    askUser: (requestId, questions) => {
      return new Promise<AskUserResult>((resolve, reject) => {
        if (!coordinator.openAsk("ask_user", { turn, turnId, requestId, questions, resolve, reject })) {
          reject(new Error("Duplicate ask-user request id"));
          return;
        }
        host.sendToClients(
          withTurnScope({ type: "ask_user_request", requestId, questions }, turn, turnId)
        );
        host.sendToClients(
          withTurnScope(
            { type: "status", status: "tool_executing", detail: "Waiting for your input" },
            turn,
            turnId
          )
        );
      });
    },
    askUserList: (requestId, request) => {
      return new Promise<AskUserListResult>((resolve, reject) => {
        // One id space across all ask kinds: a single `ask_user_cancel`
        // dismisses any of them, so an id pending as one must not open as the other.
        if (!coordinator.openAsk("ask_user_list", { turn, turnId, requestId, request, resolve, reject })) {
          reject(new Error("Duplicate ask-user request id"));
          return;
        }
        host.sendToClients(
          withTurnScope({ type: "ask_user_list_request", requestId, ...request }, turn, turnId)
        );
        host.sendToClients(
          withTurnScope(
            { type: "status", status: "tool_executing", detail: "Waiting for your input" },
            turn,
            turnId
          )
        );
      });
    },
    askUserRank: (requestId, request) => {
      // Cancellation shares one id space across all four ask kinds.
      if (coordinator.pendingAsk(requestId)) {
        return Promise.reject(new Error("Duplicate ask-user request id"));
      }
      return new Promise<AskUserRankResult>((resolve, reject) => {
        coordinator.openAsk("ask_user_rank", { turn, turnId, requestId, request, resolve, reject });
        host.sendToClients(withTurnScope({ type: "ask_user_rank_request", requestId, ...request }, turn, turnId));
        host.sendToClients(withTurnScope({ type: "status", status: "tool_executing", detail: "Waiting for your input" }, turn, turnId));
      });
    },
    askUserFormLimits: host.askUserFormLimits,
    askUserForm: (requestId, request) => {
      const validated = askUserFormSpec(request, host.askUserFormLimits);
      if (coordinator.pendingAsk(requestId)) {
        return Promise.reject(new Error("Duplicate ask-user request id"));
      }
      return new Promise<AskUserFormResult>((resolve, reject) => {
        coordinator.openAsk("ask_user_form", { turn, turnId, requestId, request: validated, resolve, reject });
        host.sendToClients(withTurnScope({ type: "ask_user_form_request", requestId, ...validated }, turn, turnId));
        host.sendToClients(withTurnScope({ type: "status", status: "tool_executing", detail: "Waiting for your input" }, turn, turnId));
      });
    },
  };
}
