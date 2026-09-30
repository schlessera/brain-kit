import { z } from "zod";
import { defineModule } from "@schlessera/brain";

/**
 * Config for the speaking module during the travel ownership transition.
 *
 * `travelParty` lets plan-travel plan for a fixed group of travelers without
 * hardcoding names. Each member may point at a `requirementsDoc` — a markdown
 * file capturing that person's travel-relevant needs (accessibility, an
 * assistance animal, a child, visa/passport constraints, dietary needs).
 * Deprecated here: migrate the complete field to the travel module. Accepted
 * for this transition so loading old config never silently drops its data.
 */
export const configSchema = z
  .object({
    travelParty: z
      .array(
        z
          .object({
            name: z.string(),
            role: z.string().optional(),
            /** Path to a traveler-requirements doc (relative to the brain root). */
            requirementsDoc: z.string().optional(),
          })
          .strict()
      )
      .default([]),
  })
  .strict();

export type SpeakingConfig = z.infer<typeof configSchema>;

export default defineModule({
  name: "speaking",
  configSchema,
  setup: (config) => {
    if (config.travelParty.length) {
      console.warn("Speaking travelParty has moved: install and enable @schlessera/brain-module-travel, then run `brain travel migrate`. Existing values are retained here until migrated.");
    }
    return {
      taxonomy: {
        types: {
          talk: { dir: "talks" },
          conference: { dir: "conferences" },
        },
        // Generic conference vocabulary. Personal venue names (e.g.
        // specific conference series a user attends every year) belong in the
        // user's own brain.config classifierHints, not here.
        classifierHints: {
          conference: [
            "cfp",
            "call for papers",
            "keynote",
            "conference",
            "submission deadline",
            "speaker slot",
          ],
        },
      },
      skills: "./skills",
      indexRules: { dirAnchors: ["status.md", "itinerary.md", "outline.md"] },
      exclude: { segments: ["alt-decks", "versions", "deck"] },
    };
  },
});
