import { z } from "zod";
import { defineModule } from "@schlessera/brain";

export const configSchema = z.object({
  travelParty: z.array(z.object({
    name: z.string(),
    role: z.string().optional(),
    requirementsDoc: z.string().optional(),
  }).strict()).default([]),
}).strict();
export type TravelConfig = z.infer<typeof configSchema>;

export default defineModule({
  name: "travel",
  configSchema,
  setup: () => ({
    taxonomy: {
      types: { travel: { dir: "travel" }, trip: { dir: "trips" }, place: { dir: "places" } },
      classifierHints: {
        travel: ["itinerary", "flight", "hotel booking", "accommodation", "road trip", "check-in", "train to"],
        trip: ["day hike", "day trip", "excursion"],
        place: ["visited place"],
      },
    },
    skills: "./skills",
    indexRules: { dirAnchors: ["status.md", "itinerary.md", "outline.md"] },
    commands: { travel: () => import("./cli.js") },
  }),
});
