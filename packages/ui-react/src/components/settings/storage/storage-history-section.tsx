import { useId, useMemo, useState } from "react";
import { Disclosure, HistoryChart } from "@schlessera/brain-ui-kit";
import type {
  StorageGuidanceResponse,
  StorageHistoryResponse,
  StorageHistoryTier,
  StorageMaintenanceRow,
} from "@schlessera/brain-ui-sdk/protocol";
import {
  STORAGE_TIER_BUCKET,
  availablePoints,
  historyThresholds,
  storageMarkers,
  storageScenarios,
  storageSeries,
  storageTimelineNote,
} from "./storage-history.js";
import type { StorageTimeline } from "./storage-timeline.js";
import { StorageHistoryTable } from "./storage-history-table.js";
import { StorageSegmented } from "./storage-segmented.js";
import { humanReason } from "./storage-model.js";
import { VOLUME_STATUS_WORD, type StorageFormat, type StorageVolume } from "./storage-volumes.js";

const STORAGE_TIERS: ReadonlyArray<{ value: StorageHistoryTier; label: string }> = [
  { value: "six-hour", label: "Recent" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];

/**
 * Available space over time for the selected volume (#4537 D3): the tier
 * switch, the chart with its scenario lines (D9) and its markers, derived
 * (D10) and from the server's timeline (#4548),
 * and the exact endpoints behind "Measurements behind this chart".
 */
export function StorageHistorySection({
  volume,
  guidance,
  history,
  maintenance,
  timeline = null,
  unavailable,
  historyUnavailable = false,
  now,
  format,
}: {
  volume: StorageVolume | null;
  guidance: StorageGuidanceResponse | null;
  history: StorageHistoryResponse | null;
  maintenance: readonly StorageMaintenanceRow[];
  /** The server's events timeline (#4548); without it the markers are derived here alone. */
  timeline?: StorageTimeline | null;
  unavailable: boolean;
  /** The history read settled without a history, as opposed to still loading. */
  historyUnavailable?: boolean;
  now: number;
  format: StorageFormat;
}) {
  const id = useId(),
    [tier, setTier] = useState<StorageHistoryTier>("six-hour");
  const pressure = volume ? guidance?.capacities.find((value) => value.identity === volume.id) ?? null : null;
  const series = useMemo(
    () => (volume && history ? storageSeries(history, volume.id, tier, now) : []),
    [volume, history, tier, now]
  );
  const notes = [
    guidance?.paused ? `History paused · ${humanReason(guidance.paused)} · last valid evidence retained` : null,
    guidance?.pending ? "A new observation is awaiting history storage · warnings stay until recovery is confirmed" : null,
    storageTimelineNote(timeline),
    unavailable ? "Current guidance could not be checked · the retained warning is out of date; refresh before relying on it" : null,
  ].filter((value): value is string => value !== null);
  const heading = `Available space · ${volume?.name ?? "no volume"}`;
  return (
    <section aria-labelledby={`${id}-heading`} className="grid min-w-0 gap-3" data-storage-history-section="">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h3 id={`${id}-heading`} className="font-semibold">
          {heading}
        </h3>
        {volume && history ? (
          <StorageSegmented label="History tier" options={STORAGE_TIERS} value={tier} onChange={setTier} />
        ) : null}
      </div>
      {!volume || !history ? (
        <p className="text-xs text-muted-foreground">
          {unavailable && guidance
            ? "? Current guidance could not be checked · the retained warning is out of date; refresh before relying on it"
            : unavailable
            ? "? History and guidance are unavailable on this host · inventory and recovery actions remain separate"
            : !volume
            ? "? No volume measured yet · Measure to see available space over time"
            : historyUnavailable
            ? "? Observation history is unavailable · read again on the next refresh"
            : "Loading history…"}
        </p>
      ) : (
        <>
          <HistoryChart
            label={`Available space, ${volume.name}, ${STORAGE_TIERS.find((value) => value.value === tier)!.label}`}
            points={availablePoints(series)}
            now={now}
            intervalMs={STORAGE_TIER_BUCKET[tier].interval}
            intervalLabel={STORAGE_TIER_BUCKET[tier].label}
            thresholds={historyThresholds(volume.capacity?.total ?? null)}
            scenarios={storageScenarios(pressure, format)}
            markers={storageMarkers({ series, identity: volume.id, pressure, maintenance, timeline, now, format })}
            nowState={VOLUME_STATUS_WORD[volume.status]}
            notes={notes}
            unmeasuredReason={series.length ? undefined : "no retained observation of this volume in this tier"}
            valueHeading="Available"
            formatValue={format.bytes}
            formatTick={format.day}
            formatTime={format.time}
          />
          <div className="[&>div>.bk-control]:min-h-11">
            <Disclosure label="Measurements behind this chart" icon="ledger">
              <StorageHistoryTable history={history} identity={volume.id} tier={tier} />
            </Disclosure>
          </div>
        </>
      )}
    </section>
  );
}
