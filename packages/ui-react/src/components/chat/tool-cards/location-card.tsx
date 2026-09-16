/**
 * The `get_current_location` result, as a card rather than a JSON blob.
 *
 * Typed `LocationPayload` — the contract's payload type — so the fields it
 * reads are the fields the handler is contracted to send. It is a pure
 * function of that payload: no store, no fetch, nothing that knows which
 * backend produced it.
 */

import { MapPin } from "lucide-react";
import type { LocationPayload } from "@schlessera/brain-ui-sdk/client";

/** 4 decimal places is ~11 m — finer than any browser fix is honest about. */
function coord(value: number): string {
  return value.toFixed(4);
}

function accuracy(meters: number): string {
  return meters >= 1000
    ? `±${(meters / 1000).toFixed(meters >= 10_000 ? 0 : 1)} km`
    : `±${Math.round(meters)} m`;
}

export function LocationResultCard({
  latitude,
  longitude,
  accuracyMeters,
  place,
  address,
  note,
  retrievedAt,
}: LocationPayload) {
  const when = new Date(retrievedAt);
  const stamp = Number.isNaN(when.getTime())
    ? retrievedAt
    : when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="flex gap-2 rounded-md bg-background/60 p-2 text-[11px] leading-relaxed">
      <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
      <div className="min-w-0 space-y-0.5">
        {/* The place name is the answer; coordinates are the evidence for it,
            so they stay visible but quiet rather than leading. */}
        <div className="truncate font-medium text-foreground">
          {place ?? "Coordinates only"}
        </div>
        {address && address !== place && (
          <div className="break-words text-muted-foreground">{address}</div>
        )}
        <div className="font-[family-name:var(--font-mono)] text-muted-foreground/70">
          {coord(latitude)}, {coord(longitude)} · {accuracy(accuracyMeters)} · {stamp}
        </div>
        {note && <div className="text-muted-foreground/70">{note}</div>}
      </div>
    </div>
  );
}
