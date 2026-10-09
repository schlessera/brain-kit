import { LOCAL_ANSWER_CLOSE, MAX_LOCAL_CONTEXT_CHARS } from "@schlessera/brain-ui-sdk/protocol";
import type { StatsSection } from "./compose-stats.js";

/**
 * The /stats answer as the agent reads it (#582): the same figures the kit
 * draws, as plain key/value lines, one section after another. Nothing is
 * added and nothing is recomputed. Every value is already the string the
 * reader was shown, so a follow-up and the screen quote the same numbers.
 *
 * Bounded to what the host accepts. A long answer loses its tail, and says
 * so, rather than the whole exchange being refused.
 */
export function statsContextText(sections: readonly StatsSection[]): string {
  const lines = sections.flatMap(sectionLines);
  const text = lines.join("\n").split(LOCAL_ANSWER_CLOSE).join("</local answer>");
  if (text.length <= MAX_LOCAL_CONTEXT_CHARS) return text;
  const cut = "\n[cut: the rest did not fit]";
  const kept = text.slice(0, MAX_LOCAL_CONTEXT_CHARS - cut.length);
  return kept.slice(0, Math.max(0, kept.lastIndexOf("\n"))) + cut;
}

function sectionLines(section: StatsSection): string[] {
  switch (section.kind) {
    case "software": {
      const { client, server, state, detail } = section.details;
      return [
        "## Software",
        `state: ${state}`,
        `client: release ${client.release ?? "unknown"}, build ${client.sourceCommit ?? "unknown"}`,
        `server: release ${server.release ?? "unknown"}, build ${server.sourceCommit ?? "unknown"}`,
        `note: ${detail}`,
      ];
    }
    case "callout":
      return [`## ${section.title}`, section.body];
    case "tiles":
      return [
        `## ${section.source === "corpus" ? "Corpus" : "Runtime"}`,
        ...section.tiles.map((tile) => `${tile.label}: ${tile.value}${tile.meta ? ` (${tile.meta})` : ""}`),
      ];
    case "bars":
      return [
        `## ${section.title}${section.meta ? ` (${section.meta})` : ""}`,
        ...section.rows.map((row) => `${row.label}: ${row.value}`),
      ];
    case "trend":
      return [
        `## Trend: ${section.label}`,
        `now: ${section.value}`,
        `series: ${section.values.join(", ")}${
          section.ticks.length ? ` (${section.ticks[0]} to ${section.ticks.at(-1)})` : ""
        }`,
      ];
    case "receipt":
      return [
        `## ${section.title}`,
        ...section.rows.map((row) => `${row.k}: ${row.v}`),
        ...(section.footnote ? [`note: ${section.footnote}`] : []),
      ];
  }
}

function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

/** The field each kind cannot be drawn without. */
const REQUIRED: Record<StatsSection["kind"], (section: Record<string, unknown>) => boolean> = {
  software: (s) => {
    const d = s.details as Record<string, unknown> | null | undefined;
    return typeof d === "object" && d !== null && isObject(d.client) && isObject(d.server);
  },
  callout: (s) => typeof s.title === "string" && typeof s.body === "string",
  tiles: (s) => Array.isArray(s.tiles),
  bars: (s) => Array.isArray(s.rows),
  trend: (s) => Array.isArray(s.values) && Array.isArray(s.ticks),
  receipt: (s) => Array.isArray(s.rows),
};

/**
 * A replayed /stats answer, if this build can draw it. The host stores the
 * answer without reading it, so it is checked here before the kit gets it:
 * a section of a kind this build does not know, or without what its kind
 * needs, is left out, and anything that is not a list is no answer at all.
 */
export function replayedStatsSections(answer: unknown): StatsSection[] | null {
  if (!Array.isArray(answer)) return null;
  return answer.filter((section): section is StatsSection => {
    if (typeof section !== "object" || section === null) return false;
    const kind = (section as { kind?: unknown }).kind;
    return (
      typeof kind === "string" &&
      Object.hasOwn(REQUIRED, kind) &&
      REQUIRED[kind as StatsSection["kind"]](section as Record<string, unknown>)
    );
  });
}
