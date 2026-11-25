import type {
  StorageHistoryObservation,
  StorageHistoryResponse,
  StorageHistoryTier,
} from "@schlessera/brain-ui-sdk/protocol";
import { bytes, exactBytes, humanReason, time } from "./storage-model.js";
const DAY = 86_400_000;
const number = (value: number) =>
  new Intl.NumberFormat("en", { maximumSignificantDigits: 3 }).format(value);
const interval = (milliseconds: number) => {
  const [value, unit] =
    milliseconds < 60_000
      ? ([Math.floor(milliseconds / 1000), "second"] as const)
      : milliseconds < 3_600_000
      ? ([Math.floor(milliseconds / 60_000), "minute"] as const)
      : milliseconds < DAY
      ? ([milliseconds / 3_600_000, "hour"] as const)
      : ([milliseconds / DAY, "day"] as const);
  return `${number(value)} ${unit}${value === 1 ? "" : "s"}`;
};
const age = (at: number, now: number) =>
  at > now ? "Clock ordering unknown" : `${interval(now - at)} ago`;
function provisional(value: StorageHistoryObservation, now: number) {
  const bucket = (at: number) =>
    value.tier === "six-hour"
      ? Math.floor(at / (6 * 3_600_000))
      : value.tier === "daily"
      ? Math.floor(at / DAY)
      : Math.floor((at - 4 * DAY) / (7 * DAY));
  return value.at <= now && bucket(value.at) === bucket(now);
}
/**
 * The exact endpoints behind the chart (#4537 D3): one row per retained
 * observation of the selected volume in the selected tier. The chart's tier
 * switch and the selected volume card drive it; it has no controls of its own.
 */
export function StorageHistoryTable({
  history,
  identity,
  tier,
}: {
  history: StorageHistoryResponse;
  identity: string;
  tier: StorageHistoryTier;
}) {
  const rows = history.observations
    .filter(
      (row) =>
        row.tier === tier &&
        row.capacities.some((capacity) => capacity.identity === identity)
    )
    .sort((a, b) => a.at - b.at);
  const now = Date.now();
  return (
    <div className="@container/storage-guidance grid min-w-0 gap-3" data-storage-history="">
        {!rows.length ? (
          <p>No retained observations in this tier.</p>
        ) : (
          <table
            className="w-full table-fixed border-collapse text-left text-xs"
            aria-label="Storage observation history"
          >
            <thead className="sr-only @[600px]/storage-guidance:not-sr-only @[600px]/storage-guidance:table-header-group">
              <tr>
                <th className="p-2">Endpoint and interval</th>
                <th className="p-2">Observed quantities</th>
                <th className="p-2">Scope and evidence</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const capacity = row.capacities.find(
                    (value) => value.identity === identity
                  )!,
                  previous = rows[index - 1];
                const same =
                  previous?.scope === row.scope &&
                  previous.capacities.find(
                    (value) => value.identity === identity
                  )?.rootScope === capacity.rootScope;
                return (
                  <tr
                    key={`${row.tier}:${row.at}`}
                    className="block border-t border-border py-2 @[600px]/storage-guidance:table-row"
                  >
                    <td className="block p-2 align-top @[600px]/storage-guidance:table-cell">
                      <p className="font-semibold">{time(row.at)}</p>
                      <p>{age(row.at, now)}</p>
                      <p>Started {time(row.startedAt)}</p>
                      <p>
                        {previous
                          ? same
                            ? `${interval(
                                row.at - previous.at
                              )} since previous endpoint`
                            : "Changed scope · no comparable interval"
                          : "First retained endpoint"}
                      </p>
                      {provisional(row, now) && (
                        <p>Current bucket · provisional</p>
                      )}
                    </td>
                    <td className="block p-2 align-top @[600px]/storage-guidance:table-cell">
                      {(["brain", "app", "operator"] as const).map((owner) => (
                        <p key={owner}>
                          {owner === "brain"
                            ? "Brain"
                            : owner === "app"
                            ? "App"
                            : "Operator"}
                          : file size{" "}
                          <span
                            title={exactBytes(capacity.owners[owner].logical)}
                          >
                            {bytes(capacity.owners[owner].logical)}
                          </span>
                          ; on disk{" "}
                          <span
                            title={exactBytes(capacity.owners[owner].allocated)}
                          >
                            {bytes(capacity.owners[owner].allocated)}
                          </span>
                        </p>
                      ))}
                      <p>
                        Object union: file size {bytes(capacity.union.logical)};
                        on disk {bytes(capacity.union.allocated)}
                      </p>
                      <p>
                        Available {bytes(capacity.available)} · free{" "}
                        {bytes(capacity.free)} · used {bytes(capacity.used)} ·
                        total {bytes(capacity.total)}
                      </p>
                    </td>
                    <td className="block p-2 align-top @[600px]/storage-guidance:table-cell">
                      <p>
                        {row.gap ? "Gap in this bucket" : "No recorded gap"}
                      </p>
                      <p>
                        Collection {row.coverage}; capacity {capacity.coverage}
                      </p>
                      <p>
                        {row.reason === "none"
                          ? "No collection exception"
                          : humanReason(row.reason)}
                      </p>
                      <p>
                        Basis {row.basis} · collector {row.collector}
                      </p>
                      <p>{row.source} observation</p>
                      <p title={row.scope}>
                        Collection scope {row.scope.slice(0, 8)}
                      </p>
                      <p title={capacity.rootScope}>
                        Root scope {capacity.rootScope.slice(0, 8)}
                      </p>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="text-xs">
          {history.observations.length} retained endpoints ·{" "}
          {history.payloadBytes === null
            ? "Payload charge unknown"
            : `${exactBytes(history.payloadBytes)} serialized history`}
          . This explanatory charge is already inside operational database
          usage; SQLite/WAL and delivery receipts cost additional physical
          storage.
        </p>
    </div>
  );
}
