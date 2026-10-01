import { z } from "zod";
import type { SharedFileMeta } from "./protocol.js";

const point = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), elevation_m: z.number().nullable(), time: z.string().nullable() });
const count = z.number().int().min(0).max(200_000);
const measure = (unit: "m" | "s") => z.object({ value: z.number().nullable(), unit: z.literal(unit), scope: z.literal("usable_sections") });
const summary = z.object({
  status: z.enum(["ok", "partial", "no_line"]), partial: z.boolean(),
  source: z.object({ kind: z.literal("file"), path: z.string().max(512), recordingClaim: z.object({ text: z.string().max(200), verified: z.literal(false) }).optional() }),
  counts: z.object({ input: count, retained: count, omitted: count, segments: count }),
  measurements: z.object({ distance: measure("m"), ascent: measure("m"), descent: measure("m"), altitudeMin: measure("m"), altitudeMax: measure("m"), elapsed: measure("s"), movingTime: measure("s") }),
  bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
  start: point.nullable(), end: point.nullable(), shape: z.enum(["loop", "one_way", "unknown"]),
  unknown: z.array(z.object({ field: z.string().max(100), reason: z.string().max(200) })).max(20),
  warnings: z.array(z.string().max(500)).max(20),
  method: z.object({ distance: z.literal("great_circle"), earthRadiusM: z.number().positive(), elevation: z.literal("three_point_median_3m_hysteresis"), elapsed: z.literal("segment_last_minus_first_with_pauses"), movingTime: z.literal("unavailable") }),
  waypointCount: count, waypointOmitted: count,
});

/** Bounded replay metadata, separate from the full original geometry. */
export const sharedFileMetaSchema: z.ZodType<SharedFileMeta> = z.looseObject({
  name: z.string().min(1).max(120), path: z.string().min(1).max(512),
  incomingName: z.string().max(100).optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), mediaType: z.string().max(130),
  bytes: z.number().int().min(0).max(25_000_000),
  detected: z.enum(["gpx", "kml", "geojson"]).optional(), summary: summary.optional(),
});
