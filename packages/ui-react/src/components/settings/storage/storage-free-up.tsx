import { useState } from "react";
import { Button, Disclosure, ToolList, ToolRow } from "@schlessera/brain-ui-kit";
import type { StorageGuidanceResponse, StorageMaintenanceRow, StorageSnapshot } from "@schlessera/brain-ui-sdk/protocol";
import { StorageDelta } from "./storage-observations.js";
import { humanReason } from "./storage-model.js";
import { toolRowView } from "./storage-tools.js";
import { running, type useStorage } from "./use-storage.js";
import type { StorageFormat, StorageVolume } from "./storage-volumes.js";
import { relevantTools } from "./storage-pane-model.js";
import { useSlotFocus } from "./storage-page-focus.js";

type StorageView = ReturnType<typeof useStorage>;

/** The prune policy, in the row's own effect copy (#4549 brief). */
const DESCRIPTION: Partial<Record<StorageMaintenanceRow["id"], string>> = {
  "prune-scratch": "Removes unpinned scratch answers older than seven days.",
};

/**
 * Free up space (#4545, #4549): one ToolRow per owner-supported tool. A run
 * this pane started shows its live receipt in its row. Its identity is kept
 * while the response is unconfirmed, so the row offers "Check receipt" and
 * never a second Run that could post twice.
 */
export function StorageFreeUp({
  view,
  guidance,
  format,
  inventory,
  volumes,
  selected,
  onFindLargeFiles,
}: {
  view: StorageView;
  guidance: StorageGuidanceResponse | null;
  format: StorageFormat;
  /** The inventory that maps each volume to its stores; `null` keeps every tool listed. */
  inventory: StorageSnapshot | null;
  volumes: readonly StorageVolume[];
  /** The volume the cards select. */
  selected: string | null;
  onFindLargeFiles?: () => void;
}) {
  const [started, setStarted] = useState<StorageMaintenanceRow["id"] | null>(null);
  const slots = useSlotFocus<HTMLDivElement>();
  const live = view.maintenanceReceipt;
  const pendingId = view.maintenanceId ? live?.operation ?? started : null;
  const inFlight = !!view.maintenanceId && (!live || running(live.state) || live.state === "unknown");
  const relevant = relevantTools(view.maintenance, { inventory, volumes, selected, keep: pendingId });
  const rows = relevant.tools.map((row) => {
    const mine = row.id === pendingId;
    const latest = mine && live ? live : row.latest;
    const props = toolRowView({ ...row, latest }, guidance, format);
    const description = DESCRIPTION[row.id];
    if (description) props.description = description;
    const unconfirmed = mine && !live;
    if (unconfirmed) {
      props.state = "unknown";
      props.reason = "response unconfirmed";
    }
    return { row, props, mine, unconfirmed };
  });
  const announcement = live && pendingId
    ? `${view.maintenance.find((row) => row.id === pendingId)?.label ?? "Maintenance"}: ${humanReason(live.state)}`
    : "";
  return (
    <div ref={slots} className="grid min-w-0 gap-2">
      <ToolList heading="Free up space" headingLevel={3} onFindLargeFiles={onFindLargeFiles} announcement={announcement}>
        {relevant.empty ? (
          <p className="text-xs text-muted-foreground" data-storage-no-tools="">
            {relevant.empty}
          </p>
        ) : null}
        {rows.map(({ row, props, mine, unconfirmed }) => (
          <div key={row.id} className="grid gap-2" data-focus-slot="">
            <ToolRow
              {...props}
              // The row's own action never leaves while its run starts,
              // settles or is cancelled: it is held instead, so a focused
              // button keeps focus (#4549). Another row's run still hides Run.
              onRun={
                inFlight && !mine
                  ? undefined
                  : () => {
                      setStarted(row.id);
                      void view.maintain(row.id);
                    }
              }
              onCancel={mine ? () => void view.cancelMaintenance() : undefined}
              actionDisabled={view.busy || (inFlight && !(mine && live && running(live.state)))}
            />
            {mine && (
              <div className="flex flex-wrap items-center gap-3">
                {(unconfirmed || live?.state === "unknown" || (live && running(live.state))) && (
                  <Button
                    label="Check receipt"
                    ariaLabel="Check maintenance receipt"
                    tone="quiet"
                    size="sm"
                    reach
                    block={false}
                    disabled={view.busy}
                    onClick={() => void view.checkMaintenance()}
                  />
                )}
                {live && !running(live.state) && (
                  <div className="min-w-0 flex-1 text-xs [&>div>.bk-control]:min-h-11">
                    <Disclosure label="Measured before → after" icon="ledger">
                      <StorageDelta before={live.before ?? null} after={live.after ?? null} />
                      {live.outcome && (
                        <p>
                          Owner result: {live.outcome.removed ?? "unknown"} removed, {live.outcome.failed ?? "unknown"} failed,{" "}
                          {live.outcome.deferred ?? "unknown"} deferred. Pinned files: {live.outcome.pinnedFiles ?? "unknown"}.
                        </p>
                      )}
                    </Disclosure>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </ToolList>
    </div>
  );
}
