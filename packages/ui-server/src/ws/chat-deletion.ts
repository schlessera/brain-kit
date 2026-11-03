/**
 * Explicit local chat deletion (#3230): one owner-authorized operation
 * retires the chat, retires its live readers and holders, then asks every
 * selected store to remove its copies under the same intent. Completion is
 * reported only when every store confirmed removal; anything else stays
 * pending, partial or unknown and is retried under the same operation, by a
 * repeated request or by restart reconciliation. Outcomes carry store
 * categories only: no text, title, raw path or free-form error.
 * Policy: docs/decisions/chat-history-deletion.md.
 */
import type { AgentBackend } from "@schlessera/brain-ui-sdk/server";
import type { ChatDeletionReceipt, ChatDeletionRetained } from "@schlessera/brain-ui-sdk/protocol";
import type { RetireChatInput, RetireChatResult, RetireRefusal, RetiredChatIdentities } from "./chat-lifecycle.js";
import { HOST_CHAT_STORES } from "./chat-store-cleanup.js";
import { removableBackendIds, removeRetiredNativeHistory } from "./native-history-removal.js";
import type { SessionCatalog } from "./session-catalog.js";

type Retired = Extract<RetireChatResult, { status: "retired" }>;

/**
 * What local deletion never removes, in every receipt: independent saved
 * content, effects and their audit, copies a provider already holds, backups
 * (an older one can restore text), and devices that are offline until they
 * reconnect and learn the chat was retired.
 */
export const CHAT_DELETION_RETAINED: readonly ChatDeletionRetained[] = ["independent_content", "effects_and_audit", "provider_copies", "backups", "offline_devices"];

export interface ChatDeletionDeps {
  catalog: Pick<SessionCatalog, "retireChat" | "chatRetirement" | "recordChatCleanup" | "cleanChatStore" | "unfinishedChatRetirements">;
  /** The installed backends; only those advertising and implementing removal are eligible. */
  backends(): Promise<AgentBackend[]>;
  /** Effect-owning work on these identities refuses deletion before retirement. */
  busy(identities: RetiredChatIdentities): boolean;
  /** Retire live holders and tell the owner's clients. Runs on every retired outcome; idempotent. */
  retired(principalId: string, retirement: Retired): void;
}

export type ChatDeletionResult = { status: "refused"; reason: RetireRefusal } | { status: "retired"; receipt: ChatDeletionReceipt };

/** The wire receipt: store categories and outcomes only. */
export function chatDeletionReceipt(retirement: Retired): ChatDeletionReceipt {
  return { operationId: retirement.operationId, generation: retirement.generation, status: retirement.cleanup,
    stores: { ...retirement.stores }, retained: [...CHAT_DELETION_RETAINED] };
}

export function createChatDeletion(deps: ChatDeletionDeps) {
  // One cleanup per retirement in this process; a concurrent repeat joins it.
  const running = new Map<string, Promise<void>>();

  async function cleanup(retirement: Retired, backends: readonly AgentBackend[]): Promise<void> {
    const { catalog } = deps;
    if (!catalog.cleanChatStore || !catalog.recordChatCleanup) throw new Error("This catalog cannot clean up chats");
    if (retirement.stores.native !== undefined && retirement.stores.native !== "removed") {
      const backend = backends.find(candidate => candidate.id === retirement.backendId);
      await removeRetiredNativeHistory(catalog, backend, retirement);
    }
    for (const store of HOST_CHAT_STORES) {
      if (retirement.stores[store] === undefined || retirement.stores[store] === "removed") continue;
      // A store that cannot run stays partial: content may remain until the retry.
      await catalog.cleanChatStore(retirement.lifecycleId, store).catch(() => catalog.recordChatCleanup!(retirement.lifecycleId, store, "partial"));
    }
  }

  function complete(retirement: Retired, backends: readonly AgentBackend[]): Promise<void> {
    const existing = running.get(retirement.lifecycleId);
    if (existing) return existing;
    const work = cleanup(retirement, backends).finally(() => { if (running.get(retirement.lifecycleId) === work) running.delete(retirement.lifecycleId); });
    running.set(retirement.lifecycleId, work);
    return work;
  }

  return {
    /**
     * Retire and clean up one chat for its authenticated owner. A repeated
     * operation key returns the same operation and retries its unfinished
     * stores; it never authorizes a replacement chat.
     */
    async delete(input: Omit<RetireChatInput, "removableBackends" | "at">): Promise<ChatDeletionResult> {
      const { catalog } = deps;
      if (!catalog.retireChat || !catalog.chatRetirement) throw new Error("This catalog cannot retire chats");
      const backends = await deps.backends();
      const result = await catalog.retireChat({ ...input, removableBackends: removableBackendIds(backends), at: Date.now() }, deps.busy);
      if (result.status === "refused") return result;
      deps.retired(input.principalId, result);
      await complete(result, backends);
      const current = await catalog.chatRetirement(result.operationId, input.principalId);
      return { status: "retired", receipt: chatDeletionReceipt((current ?? result) as Retired) };
    },
    /**
     * Restart reconciliation: finish every retirement a store has not
     * confirmed, under its original operation. Fences were already durable;
     * live holders of an earlier process are gone with it.
     */
    async reconcile(): Promise<void> {
      const pending = await deps.catalog.unfinishedChatRetirements?.() ?? [];
      if (!pending.length) return;
      const backends = await deps.backends();
      for (const retirement of pending) {
        deps.retired(retirement.principalId, retirement);
        await complete(retirement, backends).catch(() => {});
      }
    },
  };
}
export type ChatDeletion = ReturnType<typeof createChatDeletion>;
