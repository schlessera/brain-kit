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
  status: string;
  /** Lowercase kebab-case words. */
  tags: string[];
  aliases?: string[];
  /** Entities the record is about. Each id exists in `people` / `places`. */
  people?: PersonId[];
  places?: PlaceId[];
  /** One sentence; what a search result shows. */
  summary: string;
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
