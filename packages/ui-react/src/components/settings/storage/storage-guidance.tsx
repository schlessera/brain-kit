import { useId, useMemo, useState } from "react";
import { CircleHelp, TriangleAlert } from "lucide-react";
import type {
  StorageGuidanceResponse,
  StorageHistoryResponse,
  StorageHistoryObservation,
  StorageHistoryTier,
  StoragePressureView,
  StorageScenario,
  StorageObservedRate,
} from "@schlessera/brain-ui-sdk/protocol";
import { PushToggle } from "../../activity/push-toggle.js";
import {
  bytes,
  exactBytes,
  humanReason,
  time,
  type StorageMetric,
} from "./storage-model.js";
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
function Rate({
  value,
  label,
}: {
  value: StorageObservedRate | null;
  label: string;
}) {
  return value ? (
    <p>
      {label}: {value.bytesPerDay > 0 ? "+" : ""}
      {bytes(value.bytesPerDay)}/day observed
      <br />
      <span className="text-xs">
        {time(value.start)} → {time(value.end)} ·{" "}
        {interval(value.end - value.start)} · {value.samples} observations
      </span>
    </p>
  ) : (
    <p>{label}: rate unavailable · need comparable observations.</p>
  );
}
function Scenario({ value, label }: { value: StorageScenario; label: string }) {
  return (
    <div>
      <p>
        {label}:{" "}
        {value.state === "finite" && value.days !== null
          ? `${number(value.days)} days, if observed depletion continues`
          : value.state === "non-depleting"
          ? "No depletion observed in this window; future capacity is unknown"
          : `Unavailable · ${humanReason(value.reason)}`}
      </p>
      {value.start !== null && value.end !== null && (
        <p className="text-xs">
          {time(value.start)} → {time(value.end)} ·{" "}
          {interval(value.end - value.start)} · {value.samples} observations
        </p>
      )}
    </div>
  );
}
function PressureCard({
  value,
  index,
  metric,
  stale,
}: {
  value: StoragePressureView;
  index: number;
  metric: StorageMetric;
  stale: boolean;
}) {
  const id = useId(),
    evidence = value.scopeChanged ? null : value.evidence;
  const uncertain = stale || value.state !== "current" || value.scopeChanged;
  const label =
    value.severity === "critical"
      ? "Very low space"
      : value.severity === "low"
      ? "Low space"
      : uncertain
      ? "Capacity unavailable"
      : "Capacity observed";
  const Glyph = value.severity === "observed" ? CircleHelp : TriangleAlert;
  const finite =
    evidence?.short.state === "finite" &&
    evidence.long.state === "finite" &&
    evidence.short.days !== null &&
    evidence.long.days !== null;
  const name = value.scopeChanged
    ? "Earlier capacity scope"
    : value.stores[0]?.label ?? `Capacity ${index + 1}`;
  return (
    <article
      className="grid min-w-0 gap-3 rounded-lg border border-border p-3"
      aria-labelledby={`${id}-heading`}
      aria-describedby={`${id}-pressure`}
      data-storage-pressure={value.severity}
    >
      <h3 id={`${id}-heading`} className="font-semibold">
        Capacity · {name}
      </h3>
      <p id={`${id}-pressure`} className="flex items-start gap-2 font-semibold">
        <Glyph className="shrink-0" size={18} aria-hidden="true" />
        <span>
          {label}
          {uncertain ? " · Evidence unknown or out of date" : ""}
        </span>
      </p>
      {value.scopeChanged ? (
        <p>
          The observed scope changed. The earlier warning requires inspection;
          its measurements do not describe the new scope.
        </p>
      ) : (
        <p>
          Writes:{" "}
          {value.stores.map((store) => store.label).join(", ") ||
            "Current target labels unavailable; refresh to inspect."}
        </p>
      )}
      <p className="text-xs">
        Scope {value.rootScope.slice(0, 8)} · {time(value.at)} ·{" "}
        {age(value.at, Date.now())}
      </p>
      <ul className="list-disc pl-5">
        {value.causes.capacity && (
          <li>Available-capacity warning remains active.</li>
        )}
        {value.causes.forecast && (
          <li>Qualified capacity-scenario warning remains active.</li>
        )}
        {value.causes.refusals.map((refusal) => (
          <li key={`${refusal.target}:${refusal.resource}`}>
            Owner refused a write ·{" "}
            {refusal.resource === "unknown"
              ? "resource unknown"
              : refusal.resource}{" "}
            · {time(refusal.at)}.
            {refusal.successAt !== null
              ? ` A matching write succeeded ${time(
                  refusal.successAt
                )}; recovery evidence is still required.`
              : " Matching successful write has not been reported."}
          </li>
        ))}
      </ul>
      {value.recoveryAt !== null && (
        <p>
          Recovery observation recorded {time(value.recoveryAt)}. Waiting for
          another qualifying observation; every active cause must recover.
        </p>
      )}
      {evidence ? (
        <>
          <p
            title={`${exactBytes(evidence.available)} available of ${exactBytes(
              evidence.total
            )}`}
          >
            {bytes(evidence.available)} available of {bytes(evidence.total)} ·
            measured {time(evidence.at)}
            {!evidence.fresh ? " · Out of date" : ""}
          </p>
          <div
            className="grid gap-2"
            aria-label={`Observed growth for ${name}`}
          >
            <h4 className="font-semibold">
              Growth ·{" "}
              {metric === "allocated" ? "On disk estimate" : "File size"}
            </h4>
            <Rate
              label="Measured App stores"
              value={
                metric === "allocated"
                  ? evidence.appAllocated
                  : evidence.appLogical
              }
            />
            <Rate
              label="Capacity available change"
              value={evidence.availableChange}
            />
            <p className="text-xs">
              Other writers can change capacity while App usage stays flat.
              Shared extents may overlap; negative change is not proof of space
              reclaimed.
            </p>
          </div>
          <div
            className="grid gap-2"
            aria-label={`Capacity scenarios for ${name}`}
          >
            <h4 className="font-semibold">Capacity scenarios</h4>
            {finite && (
              <p data-storage-scenario-range="">
                {number(Math.min(evidence.short.days!, evidence.long.days!))}–
                {number(Math.max(evidence.short.days!, evidence.long.days!))}{" "}
                days if observed rates continue. These are two scenarios, not a
                confidence interval or deadline.
              </p>
            )}
            <Scenario label="Short window" value={evidence.short} />
            <Scenario label="Long window" value={evidence.long} />
          </div>
        </>
      ) : (
        <p>
          Available bytes, growth and capacity scenarios are unknown for this
          scope.
        </p>
      )}
    </article>
  );
}
function provisional(value: StorageHistoryObservation, now: number) {
  const bucket = (at: number) =>
    value.tier === "six-hour"
      ? Math.floor(at / (6 * 3_600_000))
      : value.tier === "daily"
      ? Math.floor(at / DAY)
      : Math.floor((at - 4 * DAY) / (7 * DAY));
  return value.at <= now && bucket(value.at) === bucket(now);
}
function HistoryTable({
  history,
  guidance,
}: {
  history: StorageHistoryResponse;
  guidance: StorageGuidanceResponse;
}) {
  const id = useId(),
    [tier, setTier] = useState<StorageHistoryTier>("six-hour"),
    [chosen, setChosen] = useState("");
  const identities = useMemo(
    () => [
      ...new Set(
        [...history.observations]
          .sort((a, b) => b.at - a.at)
          .flatMap((row) => row.capacities.map((capacity) => capacity.identity))
      ),
    ],
    [history]
  );
  const identity = identities.includes(chosen) ? chosen : identities[0] ?? "";
  const rows = history.observations
    .filter(
      (row) =>
        row.tier === tier &&
        row.capacities.some((capacity) => capacity.identity === identity)
    )
    .sort((a, b) => a.at - b.at);
  const now = Date.now();
  return (
    <details
      className="min-w-0 rounded-lg border border-border p-3"
      data-storage-history=""
    >
      <summary className="min-h-11 cursor-pointer py-3 font-semibold">
        View observations · Recent, Daily and Weekly
      </summary>
      <div className="grid min-w-0 gap-3 pt-3">
        <p>
          Actual endpoints, never averages. Current buckets are provisional;
          gaps are not zeros. Daily and weekly points are not interpolated.
          Weekly points do not supply scenarios.
        </p>
        <div className="flex flex-wrap gap-3">
          <label className="grid min-w-0 flex-1 gap-1" htmlFor={`${id}-tier`}>
            History tier
            <select
              id={`${id}-tier`}
              value={tier}
              onChange={(event) =>
                setTier(event.target.value as StorageHistoryTier)
              }
              className="min-h-11 min-w-0 rounded border border-border bg-background px-2"
            >
              <option value="six-hour">Recent · six-hour endpoints</option>
              <option value="daily">Daily · up to 90 days</option>
              <option value="weekly">Weekly · up to 32 weeks</option>
            </select>
          </label>
          <label className="grid min-w-0 flex-1 gap-1" htmlFor={`${id}-scope`}>
            Capacity scope
            <select
              id={`${id}-scope`}
              value={identity}
              onChange={(event) => setChosen(event.target.value)}
              className="min-h-11 min-w-0 rounded border border-border bg-background px-2"
            >
              {!identities.length && (
                <option value="">No observed scope</option>
              )}
              {identities.map((value) => (
                <option key={value} value={value}>
                  {guidance.capacities.find((row) => row.identity === value)
                    ?.stores[0]?.label ?? "Earlier capacity"}{" "}
                  · {value.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
        </div>
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
    </details>
  );
}
function Notices({
  value,
}: {
  value: StorageGuidanceResponse["notifications"];
}) {
  return (
    <details className="rounded-lg border border-border p-3">
      <summary className="min-h-11 cursor-pointer py-3 font-semibold">
        Critical notifications
      </summary>
      <div className="grid gap-3 pt-3">
        <p>
          Optional, through this app's existing push subscription. Only Critical
          Storage episodes can submit a notice; no recurring reminders. Opening
          this view never asks for browser permission.
        </p>
        <div className="flex min-h-11 items-center">
          <PushToggle />
        </div>
        <p>
          Quiet hours: 22:00–08:00 in the device's reported timezone. An unknown
          timezone defers delivery. Stale or unresolved evidence can remain
          visible without sending a notice.
        </p>
        {!value.subscriptions.length ? (
          <p>No bound push subscription was reported for this account.</p>
        ) : (
          <ul className="list-disc pl-5">
            {value.subscriptions.map((row, index) => (
              <li key={index}>
                Device {index + 1}:{" "}
                {!row.zoneKnown
                  ? "timezone unknown · delivery pending"
                  : row.quiet
                  ? "quiet hours · delivery deferred"
                  : "outside quiet hours; other eligibility checks still apply"}
                .
              </li>
            ))}
          </ul>
        )}
        {value.subscriptionsTruncated && (
          <p>Additional subscription summaries are not shown.</p>
        )}
        {!value.receipts.length ? (
          <p>No Storage delivery attempt recorded.</p>
        ) : (
          <ul className="grid gap-2">
            {value.receipts.map((row, index) => (
              <li key={`${row.episode}:${index}`}>
                Episode {row.episode.slice(0, 8)}:{" "}
                {row.state === "accepted"
                  ? "Accepted by push service; device display unconfirmed"
                  : row.state === "unknown"
                  ? "Unknown delivery outcome; no automatic retry"
                  : row.state === "failed"
                  ? "Known delivery failure"
                  : row.state === "suppressed"
                  ? "Suppressed · no longer eligible"
                  : row.state === "sending"
                  ? "Submission in progress; outcome unknown"
                  : "Pending eligibility checks"}{" "}
                · {row.attempts} of 3 attempts.
                {row.nextAt !== null &&
                  ` Earliest retry ${time(
                    row.nextAt
                  )}; quiet hours and fresh evidence still apply.`}
              </li>
            ))}
          </ul>
        )}
        {value.receiptsTruncated && (
          <p>Additional delivery receipts are not shown.</p>
        )}
      </div>
    </details>
  );
}
export function StorageGuidance({
  guidance,
  history,
  unavailable,
  metric,
}: {
  guidance: StorageGuidanceResponse | null;
  history: StorageHistoryResponse | null;
  unavailable: boolean;
  metric: StorageMetric;
}) {
  if (!guidance)
    return (
      <section aria-label="Storage history and guidance">
        <p>
          {unavailable
            ? "History and guidance are unavailable on this host. Inventory and recovery actions remain separate."
            : "Loading capacity guidance…"}
        </p>
      </section>
    );
  return (
    <section
      className="@container/storage-guidance grid min-w-0 gap-3"
      aria-label="Storage history and guidance"
    >
      <h2 className="text-lg font-semibold">Pressure and growth</h2>
      {unavailable && (
        <p>
          Current guidance could not be checked. The retained warning is out of
          date; refresh before relying on its measurements.
        </p>
      )}
      {guidance.paused && (
        <p>
          History paused · {humanReason(guidance.paused)}. Last valid evidence
          is retained.
        </p>
      )}
      {guidance.pending && (
        <p>
          A new observation is awaiting history storage. Existing warnings
          remain until recovery is confirmed.
        </p>
      )}
      {!guidance.capacities.length && (
        <p>
          Capacity guidance not measured yet. Use Measure to inspect current
          storage.
        </p>
      )}
      <div
        className={`grid min-w-0 gap-3 ${
          guidance.capacities.length > 1
            ? "@[600px]/storage-guidance:grid-cols-2"
            : ""
        }`}
      >
        {guidance.capacities.map((value, index) => (
          <PressureCard
            key={value.identity}
            value={value}
            index={index}
            metric={metric}
            stale={unavailable || guidance.pending}
          />
        ))}
      </div>
      {(guidance.scopeLimit || guidance.untracked.length > 0) && (
        <p>
          History is limited to four capacity scopes. History is not recorded
          for additional capacities; inspect their current inventory separately.
        </p>
      )}
      <p>
        Cleanup follows existing ownership and retention rules. If no eligible
        cleanup is found, add capacity through your host. Packing, index
        rebuilds, retained removal, Undo and backups need headroom; owner
        preflight remains final.
      </p>
      {history ? (
        <HistoryTable history={history} guidance={guidance} />
      ) : (
        <p>Observation history is unavailable.</p>
      )}
      <Notices value={guidance.notifications} />
    </section>
  );
}
