import { Hono } from "hono";
import type { ChatDeletionNotAdmitted, ChatDeletionRefusal, ChatDeletionRequest } from "@schlessera/brain-ui-sdk/protocol";
import type { AppEnv } from "../app-env.js";
import type { Principal } from "../db/principals.js";
import type { ChatDeletion } from "../ws/chat-deletion.js";

const MAX_ID = 2048;
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_ID;

/** A content-free refusal: the reason category alone, never whether someone else's chat exists. */
const REFUSALS: Record<ChatDeletionRefusal, { status: 403 | 404 | 409; message: string }> = {
  unauthorized: { status: 403, message: "Only the chat's owner, signed in as a person, can delete it." },
  unavailable: { status: 404, message: "This chat is not available to delete." },
  stale: { status: 409, message: "This chat changed since it was reviewed. Review it again before deleting." },
  unsupported: { status: 409, message: "This chat's backend cannot remove its history, so nothing was deleted." },
  busy: { status: 409, message: "This chat has work in progress. Stop or finish it first; nothing was deleted." },
};

/**
 * One answer for every operation the caller has no retirement under: unknown,
 * another principal's, a refused attempt, or a caller that cannot own one.
 */
const NOT_ADMITTED: ChatDeletionNotAdmitted = { error: "CHAT_DELETION_NOT_ADMITTED", reason: "not_admitted",
  message: "Nothing is deleted under this operation. A request still on its way can be admitted later." };

function parse(body: unknown): ChatDeletionRequest | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { operationId, target, expected } = body as Record<string, unknown>;
  if (!id(operationId) || !target || typeof target !== "object" || !expected || typeof expected !== "object") return null;
  const t = target as Record<string, unknown>, e = expected as Record<string, unknown>;
  const keys = Object.keys(t);
  if (keys.length !== 1 || !(("sessionId" in t && id(t.sessionId)) || ("historyOwnerId" in t && id(t.historyOwnerId)))) return null;
  if (!(e.backendId === null || id(e.backendId)) || typeof e.generation !== "number" || !Number.isSafeInteger(e.generation) || e.generation < 1) return null;
  return { operationId, target: "sessionId" in t ? { sessionId: t.sessionId as string } : { historyOwnerId: t.historyOwnerId as string },
    expected: { backendId: e.backendId as string | null, generation: e.generation } };
}

/**
 * `POST /api/chat-deletions` (additive, #3230): an authenticated owner
 * deletes its own chat's local history. Retirement happens before any store is
 * touched; the receipt reports each selected store's outcome and what local
 * deletion never removes. Repeating an operation ID retries its unfinished
 * stores. Agents, ambient callers without an owner mapping, revoked and
 * foreign principals are refused without content or existence leakage.
 */
export function createChatDeletionRoutes(deps: { deletion: ChatDeletion; principalValid: (principal: Principal) => boolean }): Hono<AppEnv> {
  return new Hono<AppEnv>().post("/chat-deletions", async (c) => {
    c.header("Cache-Control", "no-store");
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "Authentication required", authRequired: true }, 401);
    const request = parse(await c.req.json().catch(() => null));
    if (!request) return c.json({ error: "INVALID_CHAT_DELETION", message: "Name one chat, an operation ID and what was reviewed." }, 400);
    let result;
    try {
      result = await deps.deletion.delete({ operationId: request.operationId, principalId: principal.id,
        target: "sessionId" in request.target ? { sessionId: request.target.sessionId } : { ownerId: request.target.historyOwnerId },
        expected: request.expected });
    } catch {
      return c.json({ error: "CHAT_DELETION_FAILED", message: "The host could not record this deletion. Nothing is reported as deleted; try again." }, 500);
    }
    // Revoked while the stores were cleaned: the operation continues, the caller learns nothing.
    if (!deps.principalValid(principal)) return c.json({ error: "Authentication required", authRequired: true }, 401);
    if (result.status === "refused") {
      const refusal = REFUSALS[result.reason];
      return c.json({ error: "CHAT_DELETION_REFUSED", reason: result.reason, message: refusal.message }, refusal.status);
    }
    return c.json(result.receipt);
  })
  /**
   * `GET /api/chat-deletions/:operationId` (additive, #3455): the caller's
   * current receipt for one operation, so a client that lost a POST's reply
   * can ask without re-admitting it. Read-only: no admission, retry or
   * cleanup. Anything else, including another principal's operation or an
   * agent or ambient caller, is the same content-free `not_admitted`.
   */
  .get("/chat-deletions/:operationId", async (c) => {
    c.header("Cache-Control", "no-store");
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "Authentication required", authRequired: true }, 401);
    const operationId = c.req.param("operationId");
    if (!id(operationId)) return c.json({ error: "INVALID_CHAT_DELETION", message: "Name one operation ID." }, 400);
    let receipt;
    try {
      receipt = principal.kind === "owner" ? await deps.deletion.read(operationId, principal.id) : null;
    } catch {
      return c.json({ error: "CHAT_DELETION_FAILED", message: "The host could not read this deletion. Nothing is reported either way; try again." }, 500);
    }
    // Revoked while the catalog was read: the caller learns nothing.
    if (!deps.principalValid(principal)) return c.json({ error: "Authentication required", authRequired: true }, 401);
    return receipt ? c.json(receipt) : c.json(NOT_ADMITTED, 404);
  });
}
