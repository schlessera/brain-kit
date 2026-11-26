import type { StorageMaintenanceObservation } from "@schlessera/brain-ui-sdk/protocol";
import { bytes, time } from "./storage-model.js";
export function StorageDelta({
  before,
  after,
}: {
  before: StorageMaintenanceObservation | null;
  after: StorageMaintenanceObservation | null;
}) {
  if (!before || !after)
    return (
      <p>Before/after measurement unavailable. No reclaimed-space estimate.</p>
    );
  return (
    <section
      className="grid gap-2"
      aria-label="Before and after storage observations"
    >
      <h3 className="font-semibold">Measured before → after</h3>
      <p className="text-xs">
        {time(before.observedAt)} → {time(after.observedAt)} · {before.coverage}{" "}
        → {after.coverage}
      </p>
      {after.stores.map((row) => {
        const prior = before.stores.find((old) => old.id === row.id);
        return (
          <p key={row.id}>
            {row.label}: file size {bytes(prior?.logical ?? null)} →{" "}
            {bytes(row.logical)}; on disk estimate{" "}
            {bytes(prior?.allocated ?? null)} → {bytes(row.allocated)} ·{" "}
            {row.coverage}
          </p>
        );
      })}
      {after.capacities.map((row, index) => (
        <p key={row.id}>
          Volume {index + 1} availability:{" "}
          {bytes(
            before.capacities.find((old) => old.id === row.id)?.available ??
              null
          )}{" "}
          → {bytes(row.available)}
        </p>
      ))}
      <p>
        Other writes may change these values. Journal copies, hard links, Git
        history and backups may retain the original bytes; disk usage can grow.
      </p>
    </section>
  );
}
