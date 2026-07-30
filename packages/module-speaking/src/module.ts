import { z } from "zod";
import { defineModule } from "@brainform/core";

/**
 * Config for the speaking module.
 *
 * `travelParty` lets plan-travel plan for a fixed group of travelers without
 * hardcoding names. Each member may point at a `requirementsDoc` — a markdown
 * file capturing that person's travel-relevant needs (accessibility, an
 * assistance animal, a child, visa/passport constraints, dietary needs). The
 * doc path is read by the plan-travel skill when it builds the checklist.
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
  // Config-independent contribution: travelParty is consumed by the
  // plan-travel skill, not by the manifest.
  setup: () => ({
    taxonomy: {
      types: {
        talk: { dir: "talks" },
        conference: { dir: "conferences" },
        travel: { dir: "travel" },
      },
      // Generic conference/travel vocabulary. Personal venue names (e.g.
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
        travel: [
          "itinerary",
          "flight",
          "hotel booking",
          "accommodation",
          "road trip",
          "check-in",
          "train to",
        ],
      },
    },
    skills: "./skills",
    indexRules: { dirAnchors: ["status.md", "itinerary.md", "outline.md"] },
    exclude: { segments: ["alt-decks", "versions", "deck"] },
  }),
});
