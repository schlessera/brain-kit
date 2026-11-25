import type { Tone } from "../types.js";

/**
 * The copy and geometry behind `ToolRow` (#4545), kept pure so each rule the
 * design states is a unit test rather than a screenshot.
 *
 * Nothing here computes a delta, picks a scope or decides whether a tool is
 * shown: the caller derives those (R1, R2) and hands over finished strings.
 * What this module owns is the presentation contract: which words a receipt
 * state reads as, that an unknown is a mark and never a zero, and where the
 * headroom meter draws its fill and its marker.
 */

/** The last run as the row shows it: the receipt states, plus `never` for a
 * tool with no receipt yet. Tool availability is a separate prop. */
export type ToolRunState = "never" | "waiting" | "running" | "complete" | "partial" | "refused" | "cancelled" | "unknown";

/** Why a run's change could not be measured. These are the design's four,
 * and the only ones the row prints after "Change not measured". */
export type ToolNotMeasuredReason =
  | "before measurement missing"
  | "after measurement missing"
  | "volume changed"
  | "measurement incomplete";

/**
 * The measured change for the run's scope. `delta` is the caller's formatted,
 * signed difference in available space (`"+1.8 GB"`, `"−0.2 GB"`). There is no
 * shape for an unknown before or after: that is `notMeasured`, with its reason.
 */
export type ToolChange = { delta: string } | { notMeasured: ToolNotMeasuredReason };

/** The receipt's outcome counts. A null or absent count is left out, never
 * printed as zero. */
export interface ToolOutcomeCounts {
  packed?: number | null;
  removed?: number | null;
  failed?: number | null;
  deferred?: number | null;
  /** The brain paused the run part-way. */
  suspended?: boolean;
}

/** One headroom figure: bytes for the geometry, text for the words. */
export interface ToolHeadroomFigure {
  bytes: number;
  /** Formatted by the caller, e.g. `"2.1 GB"`. */
  text: string;
}

/**
 * Headroom for a tool that needs it. Leave the prop out for a tool that frees
 * space and has no estimate; the line is then hidden.
 *
 * The estimate describes the last recorded run and reserves nothing, so it
 * never disables Run: the server's refusal decides.
 */
export interface ToolHeadroom {
  /** The pack estimate from the last measured run. Null when none exists. */
  required: ToolHeadroomFigure | null;
  /** Available space from a comparable, fresh capacity observation. Null when
   * there is none. */
  available: ToolHeadroomFigure | null;
  /** The formatted shortfall when available is below required, e.g. `"0.4 GB"`. */
  shortfall?: string;
  /** Policy copy for a tool whose headroom cannot be drawn, shown as given in
   * place of the missing-evidence text. Ignored when the meter can be drawn. */
  note?: string;
}

interface ToolStateLine {
  /** Its shape carries the state, so it survives greyscale. */
  glyph: string;
  word: string;
  /** The recorded time or reason after the word, if any. */
  detail?: string;
  tone: Tone;
}

interface ToolStateInput {
  state: ToolRunState;
  /** The receipt's time, formatted: `"12 Jul 03:10"` or, while running, `"03:09"`. */
  at?: string;
  available?: boolean;
  unavailableReason?: string | null;
  cancelling?: boolean;
}

const busy = (state: ToolRunState) => state === "running" || state === "waiting";

/** Glyph, word and detail for the state line. */
export function toolStateLine(p: ToolStateInput): ToolStateLine {
  if (p.available === false) return { glyph: "⊘", word: "Not available here", detail: p.unavailableReason || undefined, tone: "neutral" };
  if (p.cancelling && busy(p.state)) return { glyph: "◌", word: "Cancelling…", tone: "amber" };
  const at = p.at || undefined;
  switch (p.state) {
    case "never": return { glyph: "○", word: "Never run", tone: "neutral" };
    case "waiting": return { glyph: "◌", word: "Waiting", detail: at && `queued ${at}`, tone: "neutral" };
    case "running": return { glyph: "◐", word: "Running", detail: at && `since ${at}`, tone: "amber" };
    case "complete": return { glyph: "●", word: "Done", detail: at, tone: "teal" };
    case "partial": return { glyph: "◑", word: "Partly done", detail: at, tone: "gold" };
    case "refused": return { glyph: "⊘", word: "Refused", detail: at, tone: "red" };
    case "cancelled": return { glyph: "◇", word: "Cancelled", detail: at, tone: "neutral" };
    case "unknown": return { glyph: "?", word: "Outcome unknown", detail: at, tone: "gold" };
  }
}

/** The state line as one string, for accessible names and announcements. */
export function toolStateText(line: ToolStateLine): string {
  return line.detail ? `${line.word} · ${line.detail}` : line.word;
}

/**
 * The measured-change line. A missing change, or a delta with no text, is
 * "not measured" with a reason: an unknown is never drawn as a number and
 * never as `unknown → unknown`.
 */
export function toolChangeLine(change: ToolChange | null | undefined): string {
  if (change && "delta" in change && change.delta.trim()) return `Available ${change.delta.trim()} · unattributed`;
  const reason = change && "notMeasured" in change ? change.notMeasured : "measurement incomplete";
  return `Change not measured · ${reason}`;
}

/** `Removed 41 · failed 3 · deferred 2`, from the non-null counts only. */
export function toolCountsLine(counts: ToolOutcomeCounts | null | undefined): string | null {
  if (!counts) return null;
  const valid = (n: number | null | undefined): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  const entries: Array<[string, number | null | undefined]> = [["packed", counts.packed], ["removed", counts.removed], ["failed", counts.failed], ["deferred", counts.deferred]];
  const parts = entries.flatMap(([word, n]) => (valid(n) ? [`${word} ${n}`] : []));
  if (counts.suspended) parts.push("paused by the brain");
  if (!parts.length) return null;
  const first = parts[0]!;
  parts[0] = first.charAt(0).toUpperCase() + first.slice(1);
  return parts.join(" · ");
}

interface ToolResultInput {
  state: ToolRunState;
  available?: boolean;
  reason?: string | null;
  change?: ToolChange | null;
  counts?: ToolOutcomeCounts | null;
}

/** The result lines under the state line. Running is drawn separately. */
export function toolResultLines(p: ToolResultInput): string[] {
  if (p.available === false) return [];
  const reason = p.reason?.trim() || null;
  switch (p.state) {
    case "never":
    case "running":
      return [];
    case "waiting":
      return ["Starts when the current job finishes"];
    case "complete":
      return [toolChangeLine(p.change)];
    case "partial": {
      const counts = toolCountsLine(p.counts);
      return counts ? [counts, toolChangeLine(p.change)] : [toolChangeLine(p.change)];
    }
    case "refused":
      return [reason ?? "No reason recorded"];
    case "cancelled":
      return ["Stopped before finishing · change not measured"];
    case "unknown":
      return [reason ? `Couldn't confirm the result · ${reason}` : "Couldn't confirm the result"];
  }
}

/** What the running state's slot reads: a count only when one is supplied. */
export function toolWorkingText(count?: number | null): string {
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? `Working… · ${count} done` : "Working…";
}

type ToolActionKind = "run" | "retry" | "cancel" | "none";
interface ToolAction {
  kind: ToolActionKind;
  label: string;
  disabled: boolean;
}

/** Run, Try again, Cancel or nothing. Headroom never disables Run. */
export function toolAction(p: { state: ToolRunState; available?: boolean; cancelling?: boolean }): ToolAction {
  if (p.available === false) return { kind: "none", label: "", disabled: true };
  if (busy(p.state)) return p.cancelling ? { kind: "cancel", label: "Cancelling…", disabled: true } : { kind: "cancel", label: "Cancel", disabled: false };
  if (p.state === "never" || p.state === "complete") return { kind: "run", label: "Run", disabled: false };
  return { kind: "retry", label: "Try again", disabled: false };
}

export const HEADROOM_CAVEAT = "estimate from last run · not reserved";

type ToolHeadroomView =
  | { kind: "hidden" }
  /** `text` follows the visible "Headroom" label. */
  | { kind: "text"; text: string; evidence: "note" | "no-estimate" | "no-observation" }
  | {
      kind: "meter";
      short: boolean;
      /** Fill width, 0-100, of a track whose full width is the larger figure. */
      availablePercent: number;
      /** The marker's position, 0-100. */
      requiredPercent: number;
      /** The visible caption, e.g. `needs 2.1 GB · 5.9 GB available`. */
      caption: string;
      /** The same facts for `aria-valuetext`. */
      valueText: string;
      availableBytes: number;
      maxBytes: number;
    };

const figure = (value: ToolHeadroomFigure | null | undefined, positive: boolean): ToolHeadroomFigure | null =>
  value && Number.isFinite(value.bytes) && (positive ? value.bytes > 0 : value.bytes >= 0) && value.text.trim() ? value : null;

/**
 * Headroom as a meter when both figures exist, otherwise as text.
 *
 * The track's full width is the larger of the two figures, so neither is
 * clipped and nothing on it implies a capacity the props do not carry: with
 * enough room the fill runs the whole track and the marker sits inside it at
 * the share the run needs; when short, the fill stops at what is available and
 * the hatch runs on to the marker at the track's end. A zero or invalid
 * estimate counts as missing, so a meter is never drawn against a zero.
 */
export function toolHeadroomView(headroom: ToolHeadroom | null | undefined): ToolHeadroomView {
  if (!headroom) return { kind: "hidden" };
  const required = figure(headroom.required, true);
  const available = figure(headroom.available, false);
  if (!required || !available) {
    const note = headroom.note?.trim();
    if (note) return { kind: "text", text: note, evidence: "note" };
    return required
      ? { kind: "text", text: `? · needs ${required.text} · available not measured`, evidence: "no-observation" }
      : { kind: "text", text: "? · needs an estimate from a measured run", evidence: "no-estimate" };
  }
  const max = Math.max(required.bytes, available.bytes);
  const short = available.bytes < required.bytes;
  const facts = `needs ${required.text} · ${available.text} available`;
  const shortfall = headroom.shortfall?.trim();
  const lead = short ? (shortfall ? `Short by ${shortfall}` : "Short") : null;
  return {
    kind: "meter",
    short,
    availablePercent: (available.bytes / max) * 100,
    requiredPercent: (required.bytes / max) * 100,
    caption: lead ? `▲ ${lead} · ${facts}` : facts,
    valueText: lead ? `${lead}, ${facts.replace(" · ", ", ")}` : facts.replace(" · ", ", "),
    availableBytes: available.bytes,
    maxBytes: max,
  };
}
