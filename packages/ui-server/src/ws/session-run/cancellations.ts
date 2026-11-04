import { createTurnRecorder } from "../../activity/recorder.js";
import type { WsHost } from "../host.js";
import type { RunningTurn } from "../turns.js";
import type { RunBilling } from "./billing.js";
import type { TurnLifecycle } from "./types.js";

/**
 * Write out cancellations that were accepted before a recorder existed.
 *
 * A cancel can land while routing or billing is still in flight, when there is
 * nothing to record it on yet, so the actor is buffered on the turn. Both exits
 * from that window have to drain it — the ordinary one, which then has a
 * recorder, and the revoked one, which must build a throwaway recorder rather
 * than drop a decision someone actually made.
 */
export function recordPendingCancellations(
  host: WsHost,
  turn: RunningTurn,
  billing: RunBilling | undefined,
  lifecycle?: TurnLifecycle
): void {
  if (turn.pendingCancellationPrincipalIds.length === 0) return;
  if (lifecycle && !turn.recorder) {
    for (const principalId of turn.pendingCancellationPrincipalIds) lifecycle.recordCancellation(principalId);
    turn.pendingCancellationPrincipalIds.length = 0;
    return;
  }
  const recorder =
    turn.recorder ??
    (host.activity
      ? createTurnRecorder(
          {
            store: host.activity.store,
            ...(host.activity.runtime ? { runtime: host.activity.runtime } : {}),
            ...(host.activity.governance ? { governance: host.activity.governance } : {}),
            onWrite: () => host.activity!.stream.pump(),
            log: host.log,
          },
          {
            turnId: turn.turnId,
            sessionId: turn.sessionId,
            principalId: turn.principalId,
            ...billing,
          }
        )
      : undefined);
  for (const principalId of turn.pendingCancellationPrincipalIds) {
    recorder?.recordCancellation(principalId);
  }
  turn.pendingCancellationPrincipalIds.length = 0;
}
