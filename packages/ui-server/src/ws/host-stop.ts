/**
 * Host stops (#4565): the host itself, not the user and not the turn's time
 * limit, ending a turn because something it must keep for that turn failed.
 * Every host-side owner of a turn's abort signal stops it through
 * {@link stopTurnForHost}, so the turn's outcome can name why instead of
 * reading the bare aborted signal as a timeout.
 */
import type { HostStopCause } from "@schlessera/brain-ui-sdk/protocol";
import type { RunningTurn, TurnCoordinator } from "./turns.js";

/** The reason a host-stopped turn records, for its Activity run and host work. */
export const HOST_STOP_REASONS: Readonly<Record<HostStopCause, string>> = {
  safety_recording: "Stopped by the host: the turn's safety checks could not be recorded",
  change_journal: "Stopped by the host: the turn's changes could not be recorded",
  approval_record: "Stopped by the host: an approval's outcome could not be kept",
  inbox_share: "Stopped by the host: the chat's inbox shares could not be bound",
  egress_record: "Stopped by the host: the turn's network requests could not be recorded",
};

/** The reason of an aborted turn whose stopping owner did not say why. */
export const HOST_STOP_UNSPECIFIED_REASON = "Stopped by the host";

/**
 * Stop turn `turnId` for `cause`, aborting `controller` with `error`. The
 * cause is recorded only when nothing ended the turn first: a cancel, the
 * time limit or an earlier host stop keeps its own account. The abort reason
 * stays `error` itself, so whatever unwinds the turn still classifies it.
 * The stop that records its cause also drains the turn's pending questions
 * and approvals with that cause, as the time limit drains them with its own:
 * a backend awaiting one would otherwise park until the deadline.
 */
export function stopTurnForHost(host: { readonly coordinator: Pick<TurnCoordinator, "drainPendingForTurn"> }, turn: RunningTurn, turnId: string,
  controller: AbortController, cause: HostStopCause, error: unknown): void {
  const records = turn.turnId === turnId && !controller.signal.aborted && !turn.cancelled;
  if (records) turn.hostStop = { turnId, cause };
  controller.abort(error);
  if (records) host.coordinator.drainPendingForTurn(turn, HOST_STOP_REASONS[cause]);
}

/** The cause the host stopped turn `turnId` for, if it did. */
export function hostStopOf(turn: RunningTurn, turnId: string = turn.turnId): HostStopCause | undefined {
  return turn.hostStop?.turnId === turnId ? turn.hostStop.cause : undefined;
}
