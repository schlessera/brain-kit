import type {
  StorageCapacityView,
  StorageMaintenanceObservation,
  StorageRoot,
} from "@schlessera/brain-ui-sdk/protocol";
import { bytes, humanReason, time } from "./storage-model.js";
export function StorageCapacities({
  capacities,
  roots,
}: {
  capacities: readonly StorageCapacityView[];
  roots: readonly StorageRoot[];
}) {
  const unique = [...new Map(capacities.map((row) => [row.id, row])).values()];
  return (
    <section aria-label="Storage capacities" className="grid gap-3">
      {!unique.length && <p>Capacity not measured.</p>}
      {unique.map((row) => {
        const targets =
          roots
            .filter((root) => row.rootIds.includes(root.id))
            .map((root) => root.label)
            .join(", ") || "Unresolved write targets";
        const valid =
          row.total !== null &&
          row.total > 0 &&
          row.used !== null &&
          row.free !== null &&
          row.available !== null &&
          Math.min(row.used, row.free, row.available) >= 0 &&
          row.used + row.free === row.total &&
          row.available <= row.free;
        const title =
          row.kind === "tmpfs"
            ? "Memory · temporary volume"
            : row.kind === "filesystem"
            ? "Disk · data volume"
            : "Volume · backing unknown";
        return (
          <div
            key={row.id}
            className="rounded-lg border border-border p-3 grid gap-2"
            data-storage-capacity=""
          >
            <h3 className="font-semibold">{title}</h3>
            <p>{bytes(row.available)} available to this app</p>
            {valid ? (
              <div
                role="img"
                aria-label={`${bytes(row.used)} used, ${bytes(
                  row.free! - row.available!
                )} reserved free, ${bytes(row.available)} available, ${bytes(
                  row.total
                )} total`}
                className="flex h-4 overflow-hidden rounded border border-border"
              >
                <span
                  style={{
                    width: `${(row.used! / row.total!) * 100}%`,
                    background: "var(--bk-color-ink-mute)",
                  }}
                />
                <span
                  style={{
                    width: `${
                      ((row.free! - row.available!) / row.total!) * 100
                    }%`,
                    background:
                      "repeating-linear-gradient(45deg, transparent, transparent 3px, var(--bk-color-ink-dim) 3px, var(--bk-color-ink-dim) 4px)",
                  }}
                />
                <span
                  style={{
                    width: `${(row.available! / row.total!) * 100}%`,
                    background: "var(--bk-color-raised)",
                  }}
                />
              </div>
            ) : (
              <p>
                Capacity unknown on this filesystem. {humanReason(row.reason)}
              </p>
            )}
            <p className="text-xs">
              {targets}.{" "}
              {row.kind === "tmpfs" ? "Memory-backed, not disk. " : ""}
              Filesystem observation (statfs); quota headroom unknown. Shared
              extents prevent attributing volume usage to these stores.
            </p>
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">
        Capacities are separate observations; they are never added. Remote copy
        and unobserved host stores: not measured.
      </p>
    </section>
  );
}
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
