import type { ModelUsage, TurnUsage } from "@schlessera/brain-ui-sdk/protocol";
import { sumModelUsage } from "@schlessera/brain-ui-sdk/protocol";

/** A measured request, identified by the runtime's supported OTLP source.
 * Model names, transcript titles and cumulative remainders are not provenance.
 */
export interface ClaudeTitleUsageReceipt {
  receiptId: string;
  source: "generate_session_title";
  usage: TurnUsage;
  costUsd?: number;
}

type AttributeValue = { stringValue?: unknown; intValue?: unknown; doubleValue?: unknown };
function number(value: AttributeValue | undefined): number | undefined {
  const raw = value?.intValue ?? value?.doubleValue;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && /^(0|[1-9][0-9]*)$/.test(raw)) return Number(raw);
}
function text(value: AttributeValue | undefined): string | undefined {
  return typeof value?.stringValue === "string" ? value.stringValue : undefined;
}

/** One instance belongs to one CLI process; event.sequence resets on resume.
 * Receipts are observations only. Their allocation against cumulative usage is
 * the server ledger's responsibility, so this never adds them to main usage.
 */
export class ClaudeTitleUsageEvidence {
  private readonly receipts = new Map<string, ClaudeTitleUsageReceipt>();
  private readonly processId = crypto.randomUUID();
  private invalid = false;
  ingest(payload: unknown): void {
    const resources = (payload as { resourceLogs?: unknown[] } | null)?.resourceLogs;
    if (!Array.isArray(resources)) return;
    for (const resource of resources as any[]) for (const scope of Array.isArray(resource?.scopeLogs) ? resource.scopeLogs : [])
      for (const row of Array.isArray(scope?.logRecords) ? scope.logRecords : []) {
      if (row.body?.stringValue !== "claude_code.api_request") continue;
      const attributes = new Map<string, AttributeValue>();
      let duplicate = false;
      for (const attr of Array.isArray(row.attributes) ? row.attributes : []) {
        if (typeof attr?.key !== "string" || !attr.value) continue;
        if (attributes.has(attr.key)) { duplicate = true; continue; }
        attributes.set(attr.key, attr.value);
      }
      if (duplicate) { this.invalid = true; continue; }
      const get = (key: string) => attributes.get(key);
      const source = text(get("query_source"));
      if (!source) { this.invalid = true; continue; }
      if (source !== "generate_session_title") continue;
      const model = text(get("model"));
      const sequence = number(get("event.sequence"));
      const requestId = text(get("request_id"));
      const values = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens"].map(key => number(get(key)));
      const cost = number(get("cost_usd"));
      if (!model || model.length > 256 || requestId && requestId.length > 256 || !values.every(n => Number.isSafeInteger(n) && n! >= 0)
        || (!requestId && (!Number.isSafeInteger(sequence) || sequence! < 0))
        || cost !== undefined && (!Number.isFinite(cost) || cost < 0)) { this.invalid = true; continue; }
      const receiptId = requestId ? `request:${requestId}` : `process:${this.processId}:${sequence}`;
      const usage: ModelUsage = { inputTokens: values[0], outputTokens: values[1], cacheReadTokens: values[2], cacheCreationTokens: values[3],
        ...(cost !== undefined ? { costUsd: cost } : {}) };
      const receipt: ClaudeTitleUsageReceipt = { receiptId, source: "generate_session_title", usage: sumModelUsage({ [model]: usage }), ...(cost !== undefined ? { costUsd: cost } : {}) };
      const previous = this.receipts.get(receiptId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(receipt)) { this.invalid = true; continue; }
      this.receipts.set(receiptId, receipt);
    }
  }
  snapshot(): { receipts: ClaudeTitleUsageReceipt[]; coverage: "observed" | "partial" | "unknown" } {
    return { receipts: structuredClone([...this.receipts.values()]),
      coverage: this.invalid ? "partial" : this.receipts.size ? "observed" : "unknown" };
  }
}

/** Local content-free OTLP receiver, scoped to the launching CLI. The secret
 * uses an OTEL_* header setting, which the documented CLI strips from tools.
 * No upstream destination, prompt, response or tool content is retained.
 */
export function createClaudeTitleUsageCollector() {
  const evidence = new ClaudeTitleUsageEvidence();
  const token = crypto.randomUUID();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 1024 * 1024, async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/logs") return new Response(null, { status: 404 });
    if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
    try { evidence.ingest(await request.json()); return Response.json({}); }
    catch { return new Response(null, { status: 400 }); }
  } });
  return {
    env: { OTEL_METRICS_EXPORTER: "none", OTEL_TRACES_EXPORTER: "none", CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_LOGS_EXPORTER: "otlp", OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${server.url.origin}/v1/logs`, OTEL_EXPORTER_OTLP_LOGS_HEADERS: `Authorization=Bearer ${token}`,
      OTEL_LOG_USER_PROMPTS: "0", OTEL_LOG_ASSISTANT_RESPONSES: "0", OTEL_LOG_TOOL_DETAILS: "0", OTEL_LOG_RAW_API_BODIES: "0" },
    snapshot: () => evidence.snapshot(),
    stop: () => server.stop(true),
  };
}
