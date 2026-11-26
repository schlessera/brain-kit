import { useId, useState } from "react";
import { Disclosure, TextButton } from "@schlessera/brain-ui-kit";
import type { StorageGuidanceResponse } from "@schlessera/brain-ui-sdk/protocol";
import { PushToggle } from "../../activity/push-toggle.js";
import { time } from "./storage-model.js";
import { storageAlertsLine } from "./storage-pane-model.js";

type Notifications = StorageGuidanceResponse["notifications"];

/** Whether this browser could turn push on: the difference between Off and no device. */
function pushCapable(): boolean {
  return (
    typeof window !== "undefined" &&
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    Notification.permission !== "denied"
  );
}

const RECEIPT: Record<Notifications["receipts"][number]["state"], string> = {
  accepted: "Accepted by push service; device display unconfirmed",
  unknown: "Unknown delivery outcome; no automatic retry",
  failed: "Known delivery failure",
  suppressed: "Suppressed · no longer eligible",
  sending: "Submission in progress; outcome unknown",
  pending: "Pending eligibility checks",
};

const hour = (value: number) => `${String(value).padStart(2, "0")}:00`;

/**
 * The Alerts row (#4549): `Alerts · {state}` in one mono line, ending in
 * `Change`, which reveals this device's push switch, the devices the server
 * reports and the delivery receipts. Copy follows the server: notices only at
 * Very low; the quiet hours hold Very low too; an unknown timezone sends
 * nothing. Opening the pane never asks for browser permission.
 */
export function StorageAlertsRow({
  notifications,
  onDevices,
}: {
  notifications: Notifications | null;
  onDevices: () => void;
}) {
  const id = useId(),
    [open, setOpen] = useState(false);
  const line = storageAlertsLine(notifications, pushCapable());
  return (
    <div className="grid min-w-0 gap-2" data-storage-alerts={line.state}>
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 font-mono text-xs text-muted-foreground">
        <span className="font-sans font-semibold text-foreground">Alerts</span>
        <span aria-hidden="true">·</span>
        <span className="min-w-0">{line.text}</span>
        {line.link === "devices" ? (
          <TextButton inline label="Devices" onClick={onDevices} />
        ) : line.link === "change" ? (
          <TextButton
            inline
            label="Change"
            ariaLabel="Change storage alerts"
            expanded={open}
            controls={`${id}-alerts`}
            onClick={() => setOpen((value) => !value)}
          />
        ) : null}
      </p>
      {open && notifications ? (
        <div id={`${id}-alerts`} className="grid min-w-0 max-w-[68ch] gap-3 rounded-lg border border-border p-3 text-xs">
          <div className="flex min-h-11 items-center">
            <PushToggle />
          </div>
          <p>
            Through this app's existing push subscription. Only Very low Storage
            episodes send a notice; there are no recurring reminders. Quiet hours
            {` ${hour(notifications.quietHours.start)}–${hour(notifications.quietHours.end)} `}
            in each device's reported timezone hold notices and retries. An unknown
            timezone sends nothing. Stale or unresolved evidence can stay visible
            without sending a notice.
          </p>
          {notifications.subscriptions.length ? (
            <ul className="grid gap-1" aria-label="Devices">
              {notifications.subscriptions.map((row, index) => (
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
          ) : (
            <p>No bound push subscription was reported for this account.</p>
          )}
          {notifications.subscriptionsTruncated && <p>Additional subscription summaries are not shown.</p>}
          <div className="[&>div>.bk-control]:min-h-11">
            <Disclosure
              label={`Delivery receipts · ${notifications.receipts.length}`}
              icon="ledger"
            >
              {!notifications.receipts.length ? (
                <p>No Storage delivery attempt recorded.</p>
              ) : (
                <ul className="grid gap-2">
                  {notifications.receipts.map((row, index) => (
                    <li key={`${row.episode}:${index}`}>
                      Episode {row.episode.slice(0, 8)}: {RECEIPT[row.state]} · {row.attempts} of 3 attempts.
                      {row.nextAt !== null &&
                        ` Earliest retry ${time(row.nextAt)}; quiet hours and fresh evidence still apply.`}
                    </li>
                  ))}
                </ul>
              )}
              {notifications.receiptsTruncated && <p>Additional delivery receipts are not shown.</p>}
            </Disclosure>
          </div>
        </div>
      ) : null}
    </div>
  );
}
