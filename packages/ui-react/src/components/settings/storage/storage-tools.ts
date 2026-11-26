/**
 * Maintenance tool view (#4546): the `ToolRow` props for one operation row.
 *
 * The measured change is an unattributed before → after difference in
 * available space on the one volume the run's scope lives on, or "not
 * measured" with the reason. Headroom draws `packingRequiredBytes` from the
 * row's latest receipt (#4540) against fresh capacity evidence for the same
 * volume; neither figure is ever a stand-in 0.
 */
import type {
  StorageGuidanceResponse,
  StorageMaintenanceObservation,
  StorageMaintenanceReceipt,
  StorageMaintenanceRow,
} from "@schlessera/brain-ui-sdk/protocol";
import type { ToolChange, ToolHeadroom, ToolNotMeasuredReason, ToolRowProps } from "@schlessera/brain-ui-kit";
import { humanReason } from "./storage-model.js";
import { signedBytes, storageFormat, type StorageFormat } from "./storage-volumes.js";

/** The one capacity an observation's scope lives on, or why there is none. */
function scopeCapacity(observation: StorageMaintenanceObservation) {
  const ids = new Set(observation.stores.map((store) => store.id));
  const held = observation.capacities.filter((capacity) => capacity.rootIds.some((id) => ids.has(id)));
  return held.length === 1 ? held[0]! : null;
}

/** The run's change in available space, or the reason it was not measured. */
export function toolChange(receipt: StorageMaintenanceReceipt | null, format: StorageFormat = storageFormat()): ToolChange {
  const notMeasured = (reason: ToolNotMeasuredReason): ToolChange => ({ notMeasured: reason });
  if (!receipt?.before) return notMeasured("before measurement missing");
  if (!receipt.after) return notMeasured("after measurement missing");
  const before = scopeCapacity(receipt.before),
    after = scopeCapacity(receipt.after);
  if (!before || !after) return notMeasured("measurement incomplete");
  const sameRoots =
    before.rootIds.length === after.rootIds.length && before.rootIds.every((id) => after.rootIds.includes(id));
  if (before.id !== after.id || !sameRoots || before.total !== after.total) return notMeasured("volume changed");
  if (before.identity !== "resolved" || before.available === null || after.available === null)
    return notMeasured("measurement incomplete");
  return { delta: signedBytes(after.available - before.available, format) };
}

/**
 * Headroom for `pack-git`, the one tool with an estimate. `required` is the
 * latest receipt's `packingRequiredBytes`; `available` is the scope volume's
 * capacity evidence, only while the server calls it fresh.
 */
export function toolHeadroom(
  row: StorageMaintenanceRow,
  guidance: StorageGuidanceResponse | null,
  format: StorageFormat = storageFormat()
): ToolHeadroom | undefined {
  if (row.id !== "pack-git") return undefined;
  const required = row.latest?.headroom.packingRequiredBytes ?? null;
  const observation = row.latest?.after ?? row.latest?.before ?? null;
  const capacity = observation ? scopeCapacity(observation) : null;
  const evidence = capacity
    ? guidance?.capacities.find((pressure) => pressure.identity === capacity.id)?.evidence ?? null
    : null;
  const available = evidence?.fresh && evidence.available !== null ? evidence.available : null;
  const headroom: ToolHeadroom = {
    required: required !== null && required > 0 ? { bytes: required, text: format.bytes(required) } : null,
    available: available !== null ? { bytes: available, text: format.bytes(available) } : null,
  };
  if (headroom.required && headroom.available && headroom.available.bytes < headroom.required.bytes)
    headroom.shortfall = format.bytes(headroom.required.bytes - headroom.available.bytes);
  return headroom;
}

/** The row's props, without its callbacks. */
export function toolRowView(
  row: StorageMaintenanceRow,
  guidance: StorageGuidanceResponse | null,
  format: StorageFormat = storageFormat()
): Omit<ToolRowProps, "onRun" | "onCancel" | "cancelling"> {
  const receipt = row.latest;
  const state = receipt?.state ?? "never";
  const at =
    state === "waiting"
      ? receipt?.requestedAt
      : state === "running"
      ? receipt?.startedAt ?? receipt?.requestedAt
      : receipt?.completedAt ?? receipt?.startedAt ?? receipt?.requestedAt;
  const view: Omit<ToolRowProps, "onRun" | "onCancel" | "cancelling"> = {
    name: row.label,
    description: row.effect,
    state,
    available: row.available,
    unavailableReason: row.available ? null : humanReason(row.reason),
    reason: receipt?.reason ? humanReason(receipt.reason) : null,
    effect: "maintain",
  };
  if (at !== undefined && at !== null) view.at = format.time(at);
  if (state === "complete" || state === "partial") view.change = toolChange(receipt, format);
  if (state === "partial" && receipt?.outcome) {
    const { packed, removed, failed, deferred, suspended } = receipt.outcome;
    view.counts = { packed, removed, failed, deferred, suspended };
  }
  const headroom = toolHeadroom(row, guidance, format);
  if (headroom) view.headroom = headroom;
  return view;
}
