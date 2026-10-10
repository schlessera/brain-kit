// The library: the Odysseus world at the size of a brain someone has kept for
// twenty years. Presentation data, like everything in this directory's parent:
// the demo browses, searches and graphs it, and it closes on itself.

import { crewDocuments } from "./crew.js";
import { decisionsDocuments } from "./decisions.js";
import { hubs } from "./hubs.js";
import { ithacaDocuments } from "./ithaca.js";
import { journalDocuments } from "./journal.js";
import { knowledgeDocuments } from "./knowledge.js";
import { ogygiaDocuments } from "./ogygia.js";
import { peopleDocuments } from "./people.js";
import { voyageDocuments } from "./voyage.js";
import type { LibraryDocument } from "./types.js";

export type { LibraryDocument, ShipRecord } from "./types.js";
export { shipRecords } from "./crew.js";

/** Each domain and the path prefixes it owns. */
export const libraryDomains: Record<string, { documents: LibraryDocument[]; prefixes: string[] }> = {
  hubs: { documents: hubs, prefixes: ["people/_index", "knowledge/_index", "studies/_index", "journal/_index", "decisions/_index", "oaths/_index", "omens/_index", "ithaca/_index", "ogygia/_index", "voyage/log.md", "crew/register.md"] },
  voyage: { documents: voyageDocuments, prefixes: ["voyage/legs/", "voyage/day-"] },
  crew: { documents: crewDocuments, prefixes: ["crew/"] },
  people: { documents: peopleDocuments, prefixes: ["people/"] },
  knowledge: { documents: knowledgeDocuments, prefixes: ["knowledge/", "studies/"] },
  ithaca: { documents: ithacaDocuments, prefixes: ["ithaca/"] },
  journal: { documents: journalDocuments, prefixes: ["journal/"] },
  decisions: { documents: decisionsDocuments, prefixes: ["decisions/", "oaths/", "omens/"] },
  ogygia: { documents: ogygiaDocuments, prefixes: ["ogygia/"] },
};

export const library: LibraryDocument[] = Object.values(libraryDomains).flatMap((domain) => domain.documents);
