import type { ReactNode } from "react";
import { color, font } from "../tokens.js";

export interface StorageSummaryRowProps {
  /** Defaults to "What this app added". */
  label?: string;
  /**
   * The usage sparkline (`Sparkline`, #4543), passed in as a node so the row
   * stays presentational. It should carry its own accessible text or be
   * `aria-hidden`; the row's words already say the rate and window.
   */
  chart?: ReactNode;
  /** The change over the window, pre-formatted: "+3.4 GB", or an unknown mark such as "? rate unavailable". */
  value: string;
  /** The window, pre-formatted: "7 d". */
  window: string;
}

/**
 * The summary row above the breakdown list (#4544 ruling 3):
 * `What this app added · {sparkline} · {rate} · {window}`, so "the disk
 * fills but it isn't us" is visible next to the list it summarises.
 */
export function StorageSummaryRow({ label = "What this app added", chart, value, window }: StorageSummaryRowProps) {
  const dot = (
    <span aria-hidden="true" style={{ color: color.inkMute }}>
      {"·"}
    </span>
  );
  return (
    <p
      data-storage-summary=""
      style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "2px 6px", margin: 0, minHeight: 28, font: `500 12px/1.35 ${font.body}`, color: color.ink, minWidth: 0 }}
    >
      <span style={{ fontWeight: 600 }}>{label}</span>
      {chart ? (
        <>
          {dot}
          <span data-storage-summary-chart="" style={{ display: "inline-flex", alignItems: "center", flex: "none" }}>
            {chart}
          </span>
        </>
      ) : null}
      {dot}
      <span style={{ fontFamily: font.mono, fontSize: 11.5 }}>{value}</span>
      {dot}
      <span style={{ fontFamily: font.mono, fontSize: 11.5, color: color.inkDim }}>{window}</span>
    </p>
  );
}
