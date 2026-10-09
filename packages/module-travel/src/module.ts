import { z } from "zod";
import { defineModule, type ModuleManifest } from "@schlessera/brain";

export const configSchema = z.object({
  travelParty: z.array(z.object({
    name: z.string(),
    role: z.string().optional(),
    requirementsDoc: z.string().optional(),
  }).strict()).default([]),
}).strict();
export type TravelConfig = z.infer<typeof configSchema>;

// Annotated so the public signature report records the manifest type.
const travelModule: ModuleManifest<TravelConfig> = defineModule({
  name: "travel",
  configSchema,
  setup: (config) => ({
    taxonomy: {
      types: { travel: { dir: "travel" }, trip: { dir: "trips" }, place: { dir: "places" } },
      classifierHints: {
        travel: ["itinerary", "flight", "hotel booking", "accommodation", "road trip", "check-in", "train to"],
        trip: ["day hike", "day trip", "excursion"],
        place: ["visited place"],
      },
    },
    skills: "./skills",
    instructions: { text: `## Travel workflow\n\nUse travel/ for journeys, trips/ for repeatable day trips and places/ for visited places. Keep visit identity on the canonical journey or trip and link places to those visits; unknown dates and coordinates stay unknown. Plan for the configured travel party (${config.travelParty.length} members), reading each declared requirementsDoc before proposing a route. Preserve original documents and use brain travel commands for derived assets. Run brain travel sync to regenerate the trip and place registries, preserving prose outside their regions.` },
    indexRules: { dirAnchors: ["status.md", "itinerary.md", "outline.md"] },
    commands: { travel: () => import("./cli.js") },
  }),
});

export default travelModule;
