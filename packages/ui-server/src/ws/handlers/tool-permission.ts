import { approvalRequestFrame, withTurnScope } from "../frames.js";
import { turnIdMatches, type ClientMessageHandler, type HandlerContext } from "./context.js";

/**
 * Answer a permission reply that applied to nothing pending (#957): the host
 * says what actually happened instead of letting the sender assume. A reply
 * whose turn echo does not match the settled request learns `unknown` — it
 * was never about that request.
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
    });
    return;
  }
  host.sendMessage(ws, { type: "tool_resolution", toolUseId, outcome: "unknown", ...(echoed ? { turnId: echoed } : {}) });
}

export const handleToolApproval: ClientMessageHandler<"tool_approval"> = async (ctx, msg) => {
  const { host, ws, connection, requireEcho } = ctx;
  const { coordinator } = host;
  const pending = coordinator.pendingApprovals.get(msg.toolUseId);
  if (!pending || !turnIdMatches(pending, msg.turnId, requireEcho)) {
    replyResolution(ctx, msg.toolUseId, msg.turnId);
    return;
  }
  // Voice may deny; it may never grant (docs/decisions/voice-permission.md).
  // A grant attributed to voice is refused before anything else looks
  // at it: the request stays pending, nothing is recorded or
  // remembered, and the card is still there to answer it. The wire is
  // not trusted to enforce policy — a client offering no spoken grant
  // is not the reason this holds.
  if (msg.channel === "voice") {
    host.log.emit({
      severityText: "WARN",
      body: "voice-attributed grant refused",
      attributes: {
        "tool.name": pending.request.toolName,
        "toolUse.id": pending.request.toolUseId,
      },
    });
    // The sender treated its reply as the end of the exchange — a
    // client drops the request's turn correlation once it answers, and
    // may have cleared the card — so hand it the card again, exactly
    // as a reconnect would. Without this its next answer (the card's,
    // or a spoken denial) arrives uncorrelated and is dropped too.
    host.sendMessage(
      ws,
      withTurnScope(
        approvalRequestFrame(pending.request, host.toolPermissions !== null),
        pending.turn,
        pending.turnId
      )
    );
    return;
  }
  coordinator.claimApproval(msg.toolUseId);
  // Remember-on-approve. Kind "command" never persists (the client
  // hides the option, but the wire is not trusted to enforce policy).
  // Neither does an approval given under an enforced allowlist that
  // this tool is outside of: the store is read by every OTHER turn, and
  // a grant made inside a narrower posture must not widen the ones the
  // user was not looking at. The call itself still runs — they approved
  // it — it is only the memory that is refused.
  // The store being absent is one of the reasons, not an exemption from
  // them: optional-chaining the add() away would take the "remembered"
  // branch, write nothing, log nothing, and still stamp the activity
  // record `always_allow` — the exact silent refusal this block exists
  // to rule out. Embedders wire a store (app.ts) so this is the
  // test/embedder path, which is precisely where a silent no-op is
  // hardest to notice.
  const store = host.toolPermissions;
  const remembers =
    store !== null &&
    pending.request.kind !== "command" && pending.request.kind !== "policy" &&
    !pending.request.outsideEnforcedAllowlist;
  if (msg.always && remembers) {
    await store.add(pending.request.toolName);
  } else if (msg.always) {
    // The user asked for something the host will not do. Recorded for
    // the same reason the bridge records a grant it declines to apply:
    // a refusal nobody can see is indistinguishable from a bug, and for
    // kind "command" it also says a client sent an option its own UI
    // does not offer.
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
      : { behavior: "allow" },
    {
      principalId: connection.authorization.principalId,
      ...(msg.always && remembers ? { always: true } : {}),
      ...(msg.channel ? { channel: msg.channel } : {}),
    }
  );
};

export const handleToolDenial: ClientMessageHandler<"tool_denial"> = (ctx, msg) => {
  const { host, connection, requireEcho } = ctx;
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
