/**
 * Document kinds: recipes over the one stylesheet (#530).
 *
 * A kind is not a template or a theme. It names an opener, the blocks that
 * usually follow it and an accent, and it points at a skeleton: a complete,
 * filled-in example in `skeletons/`, which is also the visual fixture for that
 * kind. `brain render --kind <kind> --scaffold` prints it, so a skill carries
 * no markup of its own and a skeleton cannot drift from the CSS it is tested
 * against.
 *
 * This entry reads the skeletons from disk, so it lives behind its own export
 * path (`@schlessera/brain-render-template/kinds`) and the main entry stays
 * free of the filesystem for the browser.
 */
import { readFileSync } from "node:fs";

import type { Accent } from "./components.js";

export interface DocumentKind {
  name: string;
  /** Other words for it, accepted by `--kind`. */
  aliases: readonly string[];
  label: string;
  /** When to pick it, in one line. */
  use: string;
  /** The opener it starts with, or "none". */
  opener: string;
  /** The blocks it typically holds, by `--blocks` name. */
  blocks: readonly string[];
  accent: Accent;
  /** Classes its skeleton sets on `<body>`. */
  switches: readonly string[];
  /** A skeleton is a full HTML document, or markdown for the plain note. */
  format: "html" | "markdown";
  /** File name under `skeletons/`. */
  file: string;
}

export const DOCUMENT_KINDS: readonly DocumentKind[] = [
  {
    name: "itinerary",
    aliases: ["day-plan", "trip", "travel-plan"],
    label: "Itinerary / day plan",
    use: "A day or a trip: where to be when, what to bring, what to watch for.",
    opener: "hero + hero image",
    blocks: ["kv--facts", "timeline", "actions", "callout", "cols", "card", "checklist", "kv--stacked", "badge"],
    accent: "teal",
    switches: [],
    format: "html",
    file: "itinerary.html",
  },
  {
    name: "brief",
    aliases: ["memo", "letter", "briefing", "proposal"],
    label: "Brief / memo / letter",
    use: "A recommendation or message for someone who has to act on it.",
    opener: "letterhead",
    blocks: ["kv--row", "summary", "numbered-heading", "quote", "callout", "checklist", "fineprint"],
    accent: "graphite",
    switches: ["doc--editorial"],
    format: "html",
    file: "brief.html",
  },
  {
    name: "report",
    aliases: ["digest", "review", "summary"],
    label: "Report / digest",
    use: "Figures over a period, and what they mean.",
    opener: "hero--solid",
    blocks: ["stats", "bars", "callout", "zebra", "fineprint"],
    accent: "blue",
    switches: [],
    format: "html",
    file: "report.html",
  },
  {
    name: "how-to",
    aliases: ["recipe", "guide", "instructions", "howto"],
    label: "How-to / recipe",
    use: "Something to make or do: what you need, then the steps in order.",
    opener: "hero--split",
    blocks: ["kv--facts", "cols", "checklist", "steps", "card"],
    accent: "amber",
    switches: [],
    format: "html",
    file: "how-to.html",
  },
  {
    name: "comparison",
    aliases: ["decision", "options", "choice"],
    label: "Comparison / decision",
    use: "Options side by side, and the one to pick.",
    opener: "hero",
    blocks: ["compare", "callout", "table", "badge"],
    accent: "purple",
    switches: [],
    format: "html",
    file: "comparison.html",
  },
  {
    name: "invoice",
    aliases: ["quote", "receipt", "estimate", "bill"],
    label: "Invoice / quote / receipt",
    use: "Money owed or paid: who, what, line items and the total.",
    opener: "letterhead",
    blocks: ["cols", "kv", "badge", "lines", "card", "actions"],
    accent: "teal",
    switches: ["doc--compact"],
    format: "html",
    file: "invoice.html",
  },
  {
    name: "invitation",
    aliases: ["event", "programme", "program", "invite"],
    label: "Invitation / programme",
    use: "An event: a cover page, then the programme and the practical facts.",
    opener: "hero--cover",
    blocks: ["timeline", "kv--facts", "actions", "callout"],
    accent: "amber",
    switches: [],
    format: "html",
    file: "invitation.html",
  },
  {
    name: "note",
    aliases: ["markdown", "plain"],
    label: "Plain note",
    use: "Anything else. Plain markdown with no classes already looks finished.",
    opener: "none",
    blocks: [],
    accent: "amber",
    switches: [],
    format: "markdown",
    file: "note.md",
  },
];

/** A kind by its name or an alias, case-insensitively. */
export function resolveKind(name: string): DocumentKind | undefined {
  const key = name.trim().toLowerCase();
  return DOCUMENT_KINDS.find((k) => k.name === key || k.aliases.includes(key));
}

/**
 * A kind's skeleton, verbatim. Resolved against this file, so it reads the
 * same `skeletons/` directory from `src/` and from `dist/`.
 */
export function readSkeleton(kind: DocumentKind): string {
  return readFileSync(new URL(`../skeletons/${kind.file}`, import.meta.url), "utf8");
}
