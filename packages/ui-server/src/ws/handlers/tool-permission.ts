import { approvalRequestFrame, withTurnScope } from "../frames.js";
import { turnIdMatches, type ClientMessageHandler, type HandlerContext } from "./context.js";

/** Arming window for revisionless replies after an in-place revision update (#4966). */
const REVISIONLESS_ARMING_WINDOW_MS = 500;

/**
 * Answer a permission reply that applied to nothing pending (#957): the host
 * says what actually happened instead of letting the sender assume. A reply
 * whose turn echo does not match the settled request learns `unknown` — it
 * was never about that request. A reply inside the durable expiry write window
 * receives a provisional `expired` with `sessionId` and no cause (#4966).
 */
function replyResolution(
  { host, ws, connection, requireEcho }: HandlerContext,
  toolUseId: string,
  echoed: string | undefined
): void {
  if (connection.capabilities?.toolResolution !== true) return;
  const record = host.coordinator.resolvedApprovals.get(toolUseId);
  if (record && turnIdMatches(record, echoed, requireEcho)) {
    host.sendMessage(ws, {
      type: "tool_resolution",
      toolUseId,
      outcome: record.outcome,
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      turnId: record.turnId,
      ...(record.channel ? { channel: record.channel } : {}),
      ...(record.reason ? { reason: record.reason } : {}),
      ...(record.expiryCause ? { expiryCause: record.expiryCause } : {}),
      ...(record.networkScope ? { networkScope: record.networkScope } : {}),
      ...(record.grantedByGrant ? { grantedByGrant: true } : {}),
    });
    return;
  }
  const expiring = host.coordinator.expiringApprovals.get(toolUseId);
  if (expiring && turnIdMatches(expiring, echoed, requireEcho)) {
    // Provisional expired with no cause while the durable write commits (#4966).
    host.sendMessage(ws, {
      type: "tool_resolution",
      toolUseId,
      outcome: "expired",
      ...(expiring.sessionId ? { sessionId: expiring.sessionId } : {}),
      turnId: expiring.turnId,
    });
    return;
  }
  host.sendMessage(ws, { type: "tool_resolution", toolUseId, outcome: "unknown", ...(echoed ? { turnId: echoed } : {}) });
}

function redeliverCard(ctx: HandlerContext, pending: { request: Parameters<typeof approvalRequestFrame>[0]; turn: Parameters<typeof withTurnScope>[1]; turnId: string }): void {
  ctx.host.sendMessage(
    ctx.ws,
    withTurnScope(
      approvalRequestFrame(pending.request, ctx.host.toolPermissions !== null),
      pending.turn,
      pending.turnId
    )
  );
}

/** True when a reply carries an outdated revision or a revisionless reply lands inside the arming window (#4966). */
function isStaleOrArmingReply(pending: { request: { revision?: string }; revisionUpdatedAt?: number }, echoedRevision: string | undefined): boolean {
  const current = pending.request.revision;
  if (!current) return false;
  if (echoedRevision !== undefined) return echoedRevision !== current;
  return pending.revisionUpdatedAt !== undefined && Date.now() - pending.revisionUpdatedAt < REVISIONLESS_ARMING_WINDOW_MS;
}

export const handleToolApproval: ClientMessageHandler<"tool_approval"> = async (ctx, msg) => {
  const { host, connection, requireEcho } = ctx;
  const { coordinator } = host;
  const pending = coordinator.pendingApprovals.get(msg.toolUseId);
  if (!pending || !turnIdMatches(pending, msg.turnId, requireEcho)) {
    replyResolution(ctx, msg.toolUseId, msg.turnId);
    return;
  }
  // Voice may deny; it may never grant (docs/decisions/voice-permission.md).
  if (msg.channel === "voice") {
    host.log.emit({
      severityText: "WARN",
      body: "voice-attributed grant refused",
      attributes: {
        "tool.name": pending.request.toolName,
        "toolUse.id": pending.request.toolUseId,
      },
    });
    redeliverCard(ctx, pending);
    return;
  }
  // Stale revision echo, or revisionless reply during the arming window (#4966):
  // do not apply; keep card pending and re-deliver the current revision.
  if (isStaleOrArmingReply(pending, msg.revision)) {
    redeliverCard(ctx, pending);
    return;
  }
  // Unadvertised networkScope is refused before claiming (#3595).
  if (msg.networkScope !== undefined) {
    const advertised = pending.request.network?.scopes;
    if (!advertised || !advertised.includes(msg.networkScope)) {
      host.log.emit({
        severityText: "WARN",
        body: "unadvertised network approval scope refused",
        attributes: {
          "tool.name": pending.request.toolName,
          "toolUse.id": pending.request.toolUseId,
          scope: msg.networkScope,
        },
      });
      redeliverCard(ctx, pending);
      return;
    }
  }
  const claimed = coordinator.claimApproval(msg.toolUseId, p => p === pending);
  if (!claimed) {
    replyResolution(ctx, msg.toolUseId, msg.turnId);
    return;
  }
  // Host-owned network scope persistence & sibling settlement (#3595, #4966).
  if (claimed.request.networkCard?.commitScope) {
    const committed = await claimed.request.networkCard.commitScope(
      msg.networkScope,
      connection.authorization.principalId,
      () => coordinator.isApprovalClaimed(msg.toolUseId, claimed)
    );
    if (!committed.ok) {
      coordinator.expireApproval(msg.toolUseId, committed.reason, committed.cause, p => p === claimed);
      return;
    }
    const settled = coordinator.settleApproval(
      msg.toolUseId,
      claimed,
      { behavior: "allow", ...(committed.scope ? { networkScope: committed.scope } : {}) },
      {
        principalId: connection.authorization.principalId,
        ...(msg.channel ? { channel: msg.channel } : {}),
        ...(committed.scope ? { networkScope: committed.scope } : {}),
      }
    );
    if (settled) {
      committed.onSettled?.();
    } else {
      await committed.onAborted?.();
    }
    return;
  }
  // Remember-on-approve. Kind "command" never persists (the client
  // hides the option, but the wire is not trusted to enforce policy).
  const store = host.toolPermissions;
  const remembers =
    store !== null &&
    pending.request.kind !== "actor" && pending.request.kind !== "command" && pending.request.kind !== "policy" &&
    !pending.request.outsideEnforcedAllowlist;
  const actorAlways = pending.request.kind === "actor" && !pending.request.outsideEnforcedAllowlist && msg.always === true;
  if (msg.always && remembers) {
    try { await store.add(pending.request.toolName); }
    catch (error) {
      host.log.emit({ severityText: "ERROR", body: "tool grant storage failed",
        attributes: { "tool.name": pending.request.toolName, "toolUse.id": msg.toolUseId,
          error: error instanceof Error ? error.message : String(error) } });
      coordinator.expireApproval(msg.toolUseId, "The tool grant could not be retained. Nothing ran; request a fresh decision.",
        "grant_storage_failed", p => p === claimed);
      return;
    }
  } else if (msg.always && !actorAlways) {
    host.log.emit({
      severityText: "INFO",
      body: "always-allow not remembered",
      attributes: {
        "tool.name": pending.request.toolName,
        "toolUse.id": pending.request.toolUseId,
        reason:
          store === null
            ? "no grant store configured"
            : pending.request.kind === "command"
              ? "per-use confirmation"
              : "outside this turn's enforced allowlist",
      },
    });
  }
  coordinator.settleApproval(
    msg.toolUseId,
    pending,
    msg.updatedInput
      ? { behavior: "allow", updatedInput: msg.updatedInput }
      : { behavior: "allow", ...(actorAlways ? { always: true } : {}) },
    {
      principalId: connection.authorization.principalId,
      ...(msg.always && (remembers || actorAlways) ? { always: true } : {}),
      ...(msg.channel ? { channel: msg.channel } : {}),
    }
  );
};

export const handleToolDenial: ClientMessageHandler<"tool_denial"> = (ctx, msg) => {
  const { host, connection, requireEcho } = ctx;
  const waiting = host.coordinator.pendingApprovals.get(msg.toolUseId);
  if (waiting && turnIdMatches(waiting, msg.turnId, requireEcho) && isStaleOrArmingReply(waiting, msg.revision)) {
    redeliverCard(ctx, waiting);
    return;
  }
  const pending = host.coordinator.claimApproval(msg.toolUseId, (p) => turnIdMatches(p, msg.turnId, requireEcho));
  if (pending) {
    host.coordinator.settleApproval(msg.toolUseId, pending, { behavior: "deny", message: msg.message }, {
      principalId: connection.authorization.principalId,
      ...(msg.channel ? { channel: msg.channel } : {}),
    });
  } else {
    // Already granted, expired, or never pending: a denial that lost a
    // race is told so, never confirmed (a visual grant stays a grant).
    replyResolution(ctx, msg.toolUseId, msg.turnId);
  }
};
