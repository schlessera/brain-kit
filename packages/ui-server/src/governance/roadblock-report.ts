import type { Database } from "bun:sqlite";
import { z } from "zod";
import { GOVERNANCE_EVENT_SCHEMAS } from "./events.js";

export const ROADBLOCK_REPORT_QUERY = z.object({
  remedy: z.enum(["actionable", "all", "guidance", "capability", "abandoned"]).default("actionable"),
  hoursBack: z.number().int().min(1).max(24 * 90).default(24),
  limit: z.number().int().min(1).max(100).default(20),
});

interface RoadblockGroup {
  signature: string;
  count: number;
  /** Preserve all remedies: one signature may need guidance in some turns and capability in others. */
  remedies: { guidance: number; capability: number; abandoned: number };
  resolved: number;
  resolutionRate: number;
  /** Sums of measured values only; null when none were measured. Unknown counts expose partial coverage. */
  waste: { tokens: number | null; costUsd: number | null; ms: number; unknownTokens: number; unknownCostUsd: number };
  exampleTurnIds: string[];
}

/** The same retained, host-local report serves HTTP and the agent activity bridge. */
export function queryRoadblockReport(db: Database, input: z.input<typeof ROADBLOCK_REPORT_QUERY>, now = Date.now()) {
  const { hoursBack, limit, remedy } = ROADBLOCK_REPORT_QUERY.parse(input);
  const since = now - hoursBack * 3_600_000;
  const groups = new Map<string, RoadblockGroup>();
  let episodes = 0;
  let unavailableEpisodes = 0;
  const rowSchema = z.object({ schema_version: z.number().int(), payload: z.string(), turn_id: z.string().nullable() });
  // Fold the entire window before taking top groups. Activity detail pruning
  // does not remove these session-retained events. Iteration avoids loading
  // all episode payloads into memory at once.
  const rows = db.query(`SELECT schema_version, payload, turn_id FROM governance_events
    WHERE kind = 'roadblock' AND at >= ? AND at <= ? ORDER BY id`).iterate(since, now);
  for (const raw of rows) {
    const row = rowSchema.parse(raw);
    if (row.schema_version !== GOVERNANCE_EVENT_SCHEMAS.roadblock.version) { unavailableEpisodes++; continue; }
    let payload: unknown;
    try { payload = JSON.parse(row.payload); } catch { unavailableEpisodes++; continue; }
    const parsed = GOVERNANCE_EVENT_SCHEMAS.roadblock.payload.safeParse(payload);
    if (!parsed.success) { unavailableEpisodes++; continue; }
    const episode = parsed.data;
    if (remedy === "actionable" ? episode.remedy === "abandoned"
      : remedy !== "all" && episode.remedy !== remedy) continue;
    episodes++;
    let group = groups.get(episode.signature);
    if (!group) {
      group = { signature: episode.signature, count: 0, remedies: { guidance: 0, capability: 0, abandoned: 0 }, resolved: 0,
        resolutionRate: 0, waste: { tokens: null, costUsd: null, ms: 0, unknownTokens: 0, unknownCostUsd: 0 }, exampleTurnIds: [] };
      groups.set(episode.signature, group);
    }
    group.count++;
    group.remedies[episode.remedy]++;
    if (episode.resolution !== null) group.resolved++;
    for (const metric of ["tokens", "costUsd"] as const) {
      const value = episode.waste[metric];
      if (value === null) group.waste[metric === "tokens" ? "unknownTokens" : "unknownCostUsd"]++;
      else group.waste[metric] = (group.waste[metric] ?? 0) + value;
    }
    group.waste.ms += episode.waste.ms;
    if (row.turn_id !== null && group.exampleTurnIds.length < 5 && !group.exampleTurnIds.includes(row.turn_id)) {
      group.exampleTurnIds.push(row.turn_id);
    }
  }
  const all = [...groups.values()];
  for (const group of all) group.resolutionRate = group.resolved / group.count;
  const lexical = (a: RoadblockGroup, b: RoadblockGroup) => a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0;
  const countOrder = (a: RoadblockGroup, b: RoadblockGroup) => b.count - a.count || lexical(a, b);
  const byWaste = (metric: "tokens" | "costUsd" | "ms") => [...all].sort((a, b) => {
    const av = a.waste[metric], bv = b.waste[metric];
    // No sample is unknown, even if another group measured a genuine zero.
    if (av === null && bv !== null) return 1;
    if (bv === null && av !== null) return -1;
    return (av !== null && bv !== null ? bv - av : 0) || countOrder(a, b);
  }).slice(0, limit);
  return { windowHours: hoursBack, episodes, totalGroups: all.length, unavailableEpisodes,
    byCount: [...all].sort(countOrder).slice(0, limit), byTokens: byWaste("tokens"), byCostUsd: byWaste("costUsd"), byTime: byWaste("ms") };
}
