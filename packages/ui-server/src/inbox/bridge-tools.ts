/** Concrete bridge over the same intake/store/resolver used by the UI. */
import type { Database } from "bun:sqlite";
import type { BackendBridge } from "@schlessera/brain-ui-sdk/server";
import { INBOX_ADD_INPUT_SCHEMA, INBOX_GET_INPUT_SCHEMA, INBOX_LIST_INPUT_SCHEMA, RESOLVE_ACTION_INPUT_SCHEMA } from "@schlessera/brain-ui-sdk/tool-contracts";
import type { V1ResolutionEffect } from "@schlessera/brain-ui-sdk/protocol";
import { isUsablePrincipal, resolvePrincipal } from "../db/principals.js";
import type { InboxIntake } from "./intake.js";
import { createInboxStore } from "./store.js";
import type { createInboxResolver } from "./resolve.js";

export interface InboxBridgeContext {
  principalId: string;
  /** Authenticated interactive arrival, or the durable thread selected by the server. */
  origin: "interactive" | { threadId: string };
  turnId: string;
  isCurrent: () => boolean;
  sessionId: () => string | undefined;
  membership: "interactive" | "voice" | "restricted";
  /** Canonical read names selected from the backend's exact autonomous roster. */
  allowedReads?: readonly ("inbox_list" | "inbox_get")[];
  /** Server-held exact approval only. V1 never creates a discuss binding. */
  approvedAction?: { sessionId: string; itemId: string; optionId: string; expectedVersion: number; effect: V1ResolutionEffect };
}
export function createInboxBridgeTools(db: Database, intake: InboxIntake, resolver: ReturnType<typeof createInboxResolver>) {
  const store = createInboxStore(db);
  return {
    forTurn(context: InboxBridgeContext): Pick<BackendBridge, "inboxList" | "inboxGet" | "inboxAdd" | "resolveAction"> {
      const { principalId, turnId, isCurrent, sessionId, membership } = context;
      const threadId = context.origin === "interactive" ? undefined : context.origin.threadId;
      // A caller cannot mutate an approved effect after this bridge is constructed.
      const approved = context.approvedAction ? structuredClone(context.approvedAction) : undefined;
      function authorize() {
        const principal = resolvePrincipal(db, principalId);
        if (!isCurrent() || !principal || !isUsablePrincipal(principal, Date.now())) throw new Error("Inbox principal or turn is no longer authorized");
        if (threadId && store.getThread(threadId)?.status !== "open") throw new Error("Inbox origin thread is unavailable");
        return principal;
      }
      const reads = [...(context.allowedReads ?? [])];
      function authorizeRead(name: "inbox_list" | "inbox_get") {
        authorize();
        if (membership === "restricted" && !reads.includes(name)) throw new Error("Inbox read is outside the exact restricted roster");
      }
      function scope(requested?: string): string | undefined {
        if (threadId && requested && requested !== threadId) throw new Error("Inbox read is outside this turn's scope");
        return threadId ?? requested;
      }
      return {
        inboxList: async input => {
          const parsed = INBOX_LIST_INPUT_SCHEMA.parse(input);
          return db.transaction(() => {
            authorizeRead("inbox_list");
            const scoped = scope(parsed.threadId), snapshot = store.snapshot();
            const items = store.orderedItems().map(row => row.item)
              .filter(item => item.queue === parsed.view && (!scoped || item.threadId === scoped)).slice(0, parsed.limit);
            return { items, threads: snapshot.threads.filter(thread => items.some(item => item.threadId === thread.id)) };
          })();
        },
        inboxGet: async input => {
          const parsed = INBOX_GET_INPUT_SCHEMA.parse(input);
          return db.transaction(() => {
            authorizeRead("inbox_get");
            const item = store.getItem(parsed.itemId);
            if (!item) throw new Error("Inbox item is unavailable");
            scope(item.threadId);
            const thread = store.getThread(item.threadId);
            if (!thread) throw new Error("Inbox thread is unavailable");
            return { item, thread };
          })();
        },
        inboxAdd: async input => {
          const parsed = INBOX_ADD_INPUT_SCHEMA.parse(input), principal = authorize();
          if (threadId && store.getThread(threadId)?.trustClass !== "trusted") throw new Error("inbox_add requires a trusted origin");
          if (membership !== "interactive") throw new Error("inbox_add is outside this turn's membership");
          // Reuse compensated, principal-checked intake; never accept a model source/trust field.
          const result = await intake.cli({ text: parsed.text, files: [] }, `bridge:${principalId}:${turnId}:${parsed.idempotencyKey}`, principal, () => { authorize(); return true; });
          return { created: result.created, threadId: result.threadId, itemId: result.itemId };
        },
        resolveAction: async input => {
          const parsed = RESOLVE_ACTION_INPUT_SCHEMA.parse(input); authorize();
          if (membership !== "interactive") throw new Error("resolve_action is outside this turn's membership");
          if (!approved || sessionId() !== approved.sessionId || parsed.sessionId !== approved.sessionId ||
            parsed.itemId !== approved.itemId || parsed.optionId !== approved.optionId || parsed.expectedVersion !== approved.expectedVersion)
            throw new Error("No matching approved session/Action binding; discuss is unavailable in v1");
          const request = { type: "inbox_resolve" as const, itemId: parsed.itemId, optionId: parsed.optionId };
          return db.transaction(() => {
            const { effect, action } = resolver.inspect(principalId, request);
            scope(action.threadId);
            if (JSON.stringify(effect) !== JSON.stringify(approved.effect)) throw new Error("Action effect no longer matches the exact approved binding");
            return resolver.resolve(principalId, request, parsed.expectedVersion);
          }).immediate();
        },
      };
    },
  };
}
