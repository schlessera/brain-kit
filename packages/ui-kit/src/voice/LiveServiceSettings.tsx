import { useId } from "react";

import { Button } from "../primitives/Button.js";
import { Callout } from "../primitives/Callout.js";
import { font } from "../tokens.js";

export interface LiveServiceOption {
  id: string;
  /** Short display name: `Gemini Live`. */
  name: string;
  /** One plain line on where audio goes. Never a credential or an endpoint. */
  detail?: string;
}

export type LiveServiceStatus =
  | { kind: "saving" }
  /** A 409: another device saved first; the latest value is shown. */
  | { kind: "stale" }
  | { kind: "failed"; text: string };

export interface LiveServiceSettingsProps {
  /** Registered (usable) services, in the host's order. */
  services: LiveServiceOption[];
  /** The checked radio. `null` checks nothing ("Pick a default"). */
  checked: string | null;
  /** The saved brain-wide default, marked `saved default`. */
  saved?: string | null;
  /** The host's default, marked `host default` while nothing is saved. */
  hostDefault?: string | null;
  /** The service a running conversation uses, marked `in use now`. */
  inUse?: string | null;
  /** A saved default the host no longer registers: a dashed row that cannot be chosen. */
  savedUnavailable?: LiveServiceOption | null;
  status?: LiveServiceStatus | null;
  /** Not the owner: the radios stay disabled and say why. */
  readOnly?: boolean;
  /** No write is possible right now (read-only, or still loading). */
  disabled?: boolean;
  loading?: boolean;
  /** The saved value could not be read. */
  loadError?: boolean;
  onChoose?: (id: string) => void;
  onRetry?: () => void;
  onReload?: () => void;
}

const mono = font.mono;

/**
 * The Live service group of Settings › Voice (#3616): which live-conversation
 * service a new Start uses when the Start card names none. One radio row per
 * registered service, saved the moment it is picked; a dashed row for a saved
 * default the host no longer registers, which cannot be chosen. A save applies
 * from the next Start and never retargets a running conversation.
 *
 * Presentation only: it opens no provider, no microphone and reads no history.
 * On a wide container the label sits in a 140px column and exactly two
 * services sit side by side.
 */
export function LiveServiceSettings(p: LiveServiceSettingsProps) {
  const id = useId();
  const heading = `${id}-heading`;
  const owner = `${id}-owner`;
  const services = p.services;
  const unavailable = p.savedUnavailable ?? null;
  const single = services.length === 1 && !unavailable;
  const disabled = p.disabled === true || p.readOnly === true;
  const marks = (service: LiveServiceOption) => [
    p.saved === service.id ? "saved default" : p.saved == null && p.hostDefault === service.id ? "host default" : null,
    p.inUse === service.id ? "in use now" : null,
  ].filter(Boolean).join(" · ");

  return (
    <div role="group" className="bk-live-service" aria-labelledby={heading} aria-busy={p.loading || undefined} data-live-service-settings="" data-count={services.length}>
      <div className="bk-live-service-grid">
      <h3 id={heading} className="bk-live-service-label">Live service</h3>
      <div className="bk-live-service-body">
        {p.loading ? <p className="bk-live-service-note">Loading the live services…</p> : null}
        {p.loadError ? (
          <div className="bk-live-service-stack">
            <Callout tone="red" variant="banner" icon="failed" text="Couldn't load the saved live service. What's shown may be out of date." />
            {p.onReload ? <div><Button label="Try again" icon="retry" tone="ghost" size="sm" block={false} reach onClick={p.onReload} /></div> : null}
          </div>
        ) : null}

        {!p.loading && services.length === 0 ? (
          <p className="bk-live-service-note" data-live-service-empty="">Live conversation isn{"’"}t set up on this host.</p>
        ) : null}

        {!p.loading && single ? (
          <div className="bk-live-service-row" data-live-service-only="">
            <span className="bk-live-service-name">{services[0]!.name}</span>
            <span className="bk-live-service-detail">The only live service on this host{services[0]!.detail ? `. ${services[0]!.detail}` : ""}</span>
          </div>
        ) : null}

        {!p.loading && !single && services.length > 0 ? (
          <>
            {unavailable ? (
              <div className="bk-live-service-row" data-unavailable="true" data-live-service-unavailable="">
                <span className="bk-live-service-name">{unavailable.name}</span>
                <span className="bk-live-service-mark" style={{ fontFamily: mono }}>saved default · not available</span>
                <span className="bk-live-service-detail">Not on this host now. Each Start asks you to choose until you pick a new default.</span>
              </div>
            ) : null}
            {p.checked === null && !unavailable ? <p className="bk-live-service-hint" data-live-service-pick="">Pick a default</p> : null}
            <div className="bk-live-service-options" role="radiogroup" aria-labelledby={heading} aria-describedby={p.readOnly ? owner : undefined}>
              {services.map((service) => {
                const isChecked = service.id === p.checked;
                const mark = marks(service);
                return (
                  <label key={service.id} className="bk-live-service-row" data-checked={isChecked || undefined} data-disabled={disabled || undefined} data-live-service-option={service.id}>
                    <input
                      type="radio"
                      name={`${id}-service`}
                      value={service.id}
                      checked={isChecked}
                      disabled={disabled}
                      aria-describedby={`${id}-${service.id}-detail`}
                      onChange={() => p.onChoose?.(service.id)}
                      className="bk-live-service-radio"
                    />
                    <span className="bk-live-service-text">
                      <span className="bk-live-service-name">{service.name}</span>
                      {mark ? <span className="bk-live-service-mark" style={{ fontFamily: mono }}>{mark}</span> : null}
                      <span id={`${id}-${service.id}-detail`} className="bk-live-service-detail">{service.detail ?? ""}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </>
        ) : null}

        {!p.loading && services.length > 0 ? (
          <p className="bk-live-service-note">Used from the next Start. A running conversation keeps its service.</p>
        ) : null}
        {p.readOnly ? <p id={owner} className="bk-live-service-note" data-live-service-owner="">Only the owner can change this.</p> : null}
        <div role="status" className="bk-live-service-note bk-live-service-status">
          {p.status?.kind === "saving" ? "Saving…" : p.status?.kind === "stale" ? "Changed on another device. Showing the latest." : ""}
        </div>
        {p.status?.kind === "failed" ? (
          <div role="alert" className="bk-live-service-stack">
            <Callout tone="red" variant="banner" icon="failed" text={p.status.text} />
            {p.onRetry ? <div><Button label="Try again" icon="retry" tone="ghost" size="sm" block={false} reach onClick={p.onRetry} /></div> : null}
          </div>
        ) : null}
      </div>
      </div>
    </div>
  );
}
