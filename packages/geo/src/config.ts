import { z } from "zod";

const endpoint = z.string().url().refine(value => {
  const url=new URL(value);
  return ["http:","https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
}, "Endpoint must be HTTP(S), without credentials, query or fragment.");
const dataset = z.object({
  url: endpoint,
  profile: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  preparedMode: z.enum(["car","foot","bike"]),
  dataset: z.string().min(1).max(200),
  verification: z.string().min(1).max(2_000),
}).strict();

/** Concrete endpoint configuration. No public service is enabled implicitly. */
export const geoConfigSchema = z.object({
  userAgent: z.string().max(500).refine(s=>!/[\u0000-\u001f\u007f]/.test(s)).default(""),
  cacheDir: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(100).max(60_000).default(5_000),
  admissionWaitMs: z.number().int().min(100).max(60_000).default(5_000),
  minimumIntervalMs: z.number().int().min(0).max(60_000).default(1_000),
  cacheTtlMs: z.number().int().min(0).max(30*24*60*60*1_000).default(24*60*60*1_000),
  geocoding: z.object({
    enabled: z.boolean().default(false),
    url: endpoint.optional(),
    publicServiceEligible: z.boolean().default(false),
  }).strict().default({enabled:false,publicServiceEligible:false}),
  routing: z.object({
    endpoints: z.object({car:dataset.optional(),foot:dataset.optional(),bike:dataset.optional()}).strict().default({}),
    demo: z.object({
      enabled: z.boolean().default(false),
      noncommercialLightUse: z.boolean().default(false),
    }).strict().default({enabled:false,noncommercialLightUse:false}),
  }).strict().default({endpoints:{},demo:{enabled:false,noncommercialLightUse:false}}),
  overpass: z.object({
    enabled: z.boolean().default(false),
    endpoints: z.array(endpoint).max(3).default([]),
  }).strict().default({enabled:false,endpoints:[]}),
}).strict();

export type GeoConfig = z.infer<typeof geoConfigSchema>;
export type GeoConfigInput = z.input<typeof geoConfigSchema>;
export type RoutingMode = "car" | "foot" | "bike";
export type RoutingDataset = z.infer<typeof dataset>;
