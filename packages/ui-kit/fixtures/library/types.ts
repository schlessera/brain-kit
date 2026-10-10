// The library's one shape.
//
// A library document is a whole Markdown record: the demo turns it into a
// file with frontmatter, and search and the graph read the same text. The
// fields here are the frontmatter a real brain would carry, plus the links
// the graph draws. Read `README.md` in the parent directory before adding a
// record; the cast, the chronology and the ledgers there are canonical.

import type { PersonId, PlaceId } from "../types.js";

/** One record in the library. */
export interface LibraryDocument {
  /** Unique across the library and every fixture table, ending in `.md`. */
  path: string;
  title: string;
  /** Runtime-validated taxonomy string, as in a real brain. */
  type: string;
  /** ISO dates, never after REFERENCE_DATE. `created` is not after `updated`. */
  created: string;
  updated: string;
  /** Absent on an unprocessed capture; every curated domain carries one. */
  status?: string;
  /** Lowercase kebab-case words in curated domains; captures may be empty or inconsistent. */
  tags: string[];
  aliases?: string[];
  /** Entities the record is about. Each id exists in `people` / `places`. */
  people?: PersonId[];
  places?: PlaceId[];
  /** One sentence; what a search result shows. Absent on an unprocessed capture. */
  summary?: string;
  /**
   * Markdown body, without the H1 (the demo writes the title). A wiki-link is
   * written by full path without the extension -- `[[people/penelope]]` --
   * and every one also appears in `links`.
   */
  body: string;
  /** Outbound links by target path. Every one resolves. */
  links: string[];
  /** Extra frontmatter fields. Scalars only, so the frontmatter stays flat. */
  fields?: Record<string, string | number | boolean>;
}

/** One of the twelve ships out of Troy, for the crew ledger to close against. */
export interface ShipRecord {
  /** 1-12. Ship 1 is Odysseus's own. */
  ship: number;
  path: string;
  embarked: number;
  /** Losses by `crewLosses[].place`. Sums across ships equal the ledger. */
  lost: Record<string, number>;
}

/**
 * The library's deliberate defects, declared so they stay engineered: a real
 * brain has links to notes never written, captures nobody linked and notes
 * that link nowhere. The test asserts these occur exactly as declared.
 */
export interface KnownIssues {
  /** `[from, to]`: a link or wiki-link whose target was never written. */
  unresolved: [string, string][];
  /** Records with no link in or out. */
  orphans: string[];
}

