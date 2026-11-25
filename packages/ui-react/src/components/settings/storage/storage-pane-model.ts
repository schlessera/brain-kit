/**
 * The composed Storage pane's words (#4549): the header status line, the
 * Alerts row, the attention banner and the "What this app added" summary.
 * Pure functions over the wire types and the #4546 view models, so every
 * rule the approved design states is a unit test.
 *
 * The epic's rules hold here too: an unknown is a mark ("?", "not
 * measured"), never `0`; capacities are never added together; the wording
 * is "available", never "free" (#4537 D5).
 */
import type {
  StorageGuidanceResponse,
  StorageObservedRate,
  StoragePressureView,
  StorageSnapshot,
  StorageStatus,
} from "@schlessera/brain-ui-sdk/protocol";
import { humanReason } from "./storage-model.js";
import { DAY_MS, signedBytes, storageFormat, type StorageFormat, type StorageVolume } from "./storage-volumes.js";

const count = (value: number) => new Intl.NumberFormat("en").format(value);

/** The header's single mono line and the one action beside it. */
export interface StorageStatusLine {
  state: "loading" | "never" | "measuring" | "failed" | "out-of-date" | "partial" | "complete";
  /** Its shape carries the state, so it survives greyscale. */
  glyph: string;
  text: string;
  /** `measure` is the pane's one primary-tone button, shown only when nothing was ever measured. */
  action: "measure" | "measure-again" | "cancel" | null;
}

function age(from: number, now: number): string {
  const hours = Math.max(0, Math.round((now - from) / 3_600_000));
  if (hours < 1) return "under 1 h ago";
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/**
 * The status line for one inventory state (#4549 brief, item 4). The
 * snapshot is the one the pane shows; `now` decides Out of date from its
 * existing `staleAfter`.
 */
export function storageStatusLine(input: {
  status: StorageStatus | null;
  snapshot: StorageSnapshot | null;
  now: number;
  format?: StorageFormat;
}): StorageStatusLine {
  const format = input.format ?? storageFormat();
  const { status, snapshot, now } = input;
  if (!status) return { state: "loading", glyph: "○", text: "Loading Storage…", action: null };
  const showing = snapshot ? `showing ${format.time(snapshot.observedAt)}` : "nothing measured yet";
  if (status.state === "scanning") return { state: "measuring", glyph: "◐", text: `Measuring… · ${showing}`, action: "cancel" };
  const failure = status.lastFailure;
  if (failure && (!snapshot || failure.at > snapshot.observedAt))
    return {
      state: "failed",
      glyph: "!",
      text: `Last measurement failed · ${humanReason(failure.reason)} · ${showing}`,
      action: snapshot ? "measure-again" : "measure",
    };
  if (!snapshot) return { state: "never", glyph: "○", text: "Not measured yet", action: "measure" };
  if (now >= snapshot.staleAfter)
    return {
      state: "out-of-date",
      glyph: "◷",
      text: `Out of date · measured ${format.time(snapshot.observedAt)} (${age(snapshot.observedAt, now)})`,
      action: "measure-again",
    };
  if (snapshot.coverage !== "complete") {
    const missing = snapshot.roots.filter((root) => root.coverage === "unknown").length;
    return {
      state: "partial",
      glyph: "◑",
      text: [
        `Measured ${format.time(snapshot.observedAt)}`,
        "partial",
        `≥ ${count(snapshot.entries)} entries`,
        missing ? `${missing} ${missing === 1 ? "store" : "stores"} not measured` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      action: "measure-again",
    };
  }
  return {
    state: "complete",
    glyph: "●",
    text: `Measured ${format.time(snapshot.observedAt)} · complete · ${count(snapshot.entries)} entries`,
    action: "measure-again",
  };
}

/** The Alerts row (#4549 maintainer decision, 2026-11-25). */
export interface StorageAlertsLine {
  state: "on" | "off" | "quiet" | "unknown-zone" | "no-device" | "unavailable";
  /** The phrase after "Alerts ·". */
  text: string;
  /** Where the row's trailing link goes: the notification controls, or Devices to add one. */
  link: "change" | "devices" | null;
}

const hour = (value: number) => `${String(value).padStart(2, "0")}:00`;

/**
 * Alerts copy follows the server (`packages/ui-server/src/storage/notify-writes.ts`):
 * a notice is sent only at Very low; the quiet hours suppress Very low too,
 * and an unknown timezone sends nothing. The bounds come from the guidance
 * response's `quietHours`, never from literals.
 *
 * `pushCapable` says whether this browser could turn push on, which is what
 * separates Off (turn it on here) from no device (add one elsewhere).
 */
export function storageAlertsLine(
  notifications: StorageGuidanceResponse["notifications"] | null,
  pushCapable: boolean
): StorageAlertsLine {
  if (!notifications) return { state: "unavailable", text: "? not available on this host", link: null };
  const { start, end } = notifications.quietHours;
  const devices = notifications.subscriptions;
  if (!devices.length)
    return pushCapable
      ? { state: "off", text: "Off · you won't be told when space runs very low", link: "change" }
      : { state: "no-device", text: "? no device to notify · add one in Devices", link: "devices" };
  const known = devices.filter((device) => device.zoneKnown);
  if (!known.length) return { state: "unknown-zone", text: "On · ? no alerts · timezone unknown", link: "change" };
  if (known.every((device) => device.quiet === true))
    return { state: "quiet", text: `On · ◑ quiet until ${hour(end)}`, link: "change" };
  return { state: "on", text: `On · at Very low · quiet ${hour(start)}–${hour(end)}`, link: "change" };
}

/** The attention banner (D4): one sentence, only when a volume is Low or Very low. */
export interface StorageBanner {
  severity: "low" | "critical";
  volumeId: string;
  title: string;
  text: string;
}

function rateSentence(pressure: StoragePressureView | null | undefined): string | null {
  const evidence = pressure && !pressure.scopeChanged ? pressure.evidence : null;
  if (!evidence) return null;
  const finite = (["short", "long"] as const)
    .map((window) => evidence[window])
    .find((scenario) => scenario.state === "finite" && scenario.days !== null && scenario.start !== null && scenario.end !== null);
  if (!finite) return null;
  const span = Math.max(1, Math.round((finite.end! - finite.start!) / DAY_MS));
  const days = new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(finite.days!);
  return `At the ${span}-day rate it runs out in about ${days} ${days === "1" ? "day" : "days"}.`;
}

/**
 * The worst Low or Very low volume, in words. `null` when every volume is
 * OK or unknown: there is no banner then. The figures are that volume's
 * own; nothing is summed across volumes.
 */
export function storageBanner(
  volumes: readonly StorageVolume[],
  guidance: StorageGuidanceResponse | null,
  format: StorageFormat = storageFormat()
): StorageBanner | null {
  const worst = volumes.find((volume) => volume.severity === "critical" || volume.severity === "low");
  if (!worst) return null;
  const severity = worst.severity as "low" | "critical";
  const pressure = guidance?.capacities.find((value) => value.identity === worst.id) ?? null;
  const figures = worst.capacity
    ? `${format.bytes(worst.capacity.available)} available of ${format.bytes(worst.capacity.total)}.`
    : "Available space not measured.";
  const name = worst.identified ? worst.name : "A volume";
  return {
    severity,
    volumeId: worst.id,
    title: `${name} is ${severity === "critical" ? "Very low" : "Low"}`,
    text: [figures, rateSentence(pressure)].filter(Boolean).join(" "),
  };
}

/** "What this app added": the App stores' change over the rate's own window. */
export function appAddedSummary(
  rate: StorageObservedRate | null | undefined,
  format: StorageFormat = storageFormat()
): { value: string; window: string; spoken: string } {
  if (!rate) return { value: "? rate unavailable", window: "no comparable window", spoken: "App usage change unavailable" };
  const days = Math.max(1, Math.round((rate.end - rate.start) / DAY_MS));
  const change = Math.round(rate.bytesPerDay * ((rate.end - rate.start) / DAY_MS));
  const value = signedBytes(change, format);
  return { value, window: `${days} d`, spoken: `App changed ${value} in ${days} ${days === 1 ? "day" : "days"}` };
}

/** The Larger than presets (#4549 brief); 5 MB is D11's bound default. */
export const LARGER_PRESETS: ReadonlyArray<{ value: string; label: string }> = Object.freeze([
  { value: "5", label: "5 MB" },
  { value: "10", label: "10 MB" },
  { value: "100", label: "100 MB" },
  { value: "500", label: "500 MB" },
  { value: "1000", label: "1 GB" },
]);
