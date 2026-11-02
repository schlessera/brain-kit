/**
 * Fictional Odysseus Apify fixtures (#3161): a qualified profile for the
 * imaginary `odysseus/sea-charts` build. Every id, price and origin is
 * invented for tests; nothing here describes a real Actor or tariff.
 */
import { canonicalJson, sha256 } from "@schlessera/brain/internal/apify";
import type { ApifyQualifiedProfile } from "@schlessera/brain/internal/apify";

export const SEA_CHARTS_SCHEMA = {
  title: "Sea charts input", type: "object", schemaVersion: 1,
  properties: {
    startUrls: { title: "Chart pages", type: "array", editor: "requestListSources", minItems: 1, maxItems: 5 },
    maxPages: { title: "Most chart pages", type: "integer", minimum: 1, maximum: 100 },
    harbour: { title: "Harbour", type: "string", enum: ["ithaca", "pylos", "sparta"], nullable: true },
  },
  required: ["startUrls", "maxPages"],
} as const;

export const SEA_CHARTS_PRICING = [{
  pricingModel: "PAY_PER_EVENT", startedAt: "2026-01-01T00:00:00.000Z", createdAt: "2025-12-01T00:00:00.000Z", apifyMarginPercentage: 0.2,
  isPPEPlatformUsagePaidByUser: false, minimalMaxTotalChargeUsd: 0.5,
  pricingPerEvent: { actorChargeEvents: {
    "apify-actor-start": { eventTitle: "Voyage start", eventDescription: "One start", eventPriceUsd: 0.05 },
    "chart-page": { eventTitle: "Chart page", eventDescription: "One chart page", eventPriceUsd: 0.01 },
  } },
}];

export function seaChartsProfile(overrides: Partial<ApifyQualifiedProfile> = {}, schema: unknown = SEA_CHARTS_SCHEMA, pricing: unknown = SEA_CHARTS_PRICING): ApifyQualifiedProfile {
  return {
    id: "odysseus-sea-charts@1", actor_id: "SeaCharts01", build_number: "1.4.2",
    schema_sha256: sha256(canonicalJson(schema)), pricing_sha256: sha256(canonicalJson(pricing)),
    input_schema: schema as ApifyQualifiedProfile["input_schema"],
    billing: { model: "PAY_PER_EVENT", platform_usage: "included", currency_cap: "verified",
      events: { "apify-actor-start": 0.05, "chart-page": 0.01 }, minimal_max_total_charge_usd: 0.5 },
    targets: [{ field: "startUrls", shape: "request_list" }],
    work_limits: [{ field: "maxPages", limit: "max_result_items" }],
    site: { expansion: "none", redirects: "same_origin", authorization: "written_permission", permitted_origins: ["https://ithaca.example", "https://pylos.example"] },
    run: { memory_mbytes: 1024, max_timeout_seconds: 900 },
    output: { max_item_bytes: 4096 },
    lifecycle: { request_usd: 0.0004, storage_usd_per_gb_day: 0.5, remote_retention_days: 7, status_requests: 12, result_requests: 6, abort_requests: 2 },
    effects: "read_only",
    ...overrides,
  };
}
