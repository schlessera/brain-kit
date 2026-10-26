/**
 * Classified blocks and classifier confidence off the event loop (#2850): a
 * turn's classified blocks, the blocks that follow a promoted link and the
 * confidence behind a pass commit on the `ui.db` write worker at
 * `synchronous=FULL`, through the writers that ran inline. Replay joins
 * blocks only after every write submitted before it has settled.
 */
import type { Database } from "bun:sqlite";
import type { MessageBlock } from "@schlessera/brain-ui-sdk/protocol";

import type { WriteProcedures } from "../db/write-worker.js";
import { rewriteMessageBlockLinks, saveMessageBlocks } from "./blocks-store.js";
import type { QuestionObservation } from "@schlessera/brain-ui-sdk/internal";
import { recordQuestionConfidence } from "./confidence-store.js";

export const url = import.meta.url;

export function setup(db: Database): WriteProcedures {
  return {
    saveBlocks: (sessionId: string, partText: string, blocks: MessageBlock[], at: number) => saveMessageBlocks(db, sessionId, partText, blocks, at),
    rewriteLinks: (sessionId: string, textParts: string[], links: [string, string][]) => rewriteMessageBlockLinks(db, sessionId, textParts, new Map(links)),
    confidence: (sessionId: string, observations: QuestionObservation[], at: number) => recordQuestionConfidence(db, sessionId, observations, at),
  };
}
