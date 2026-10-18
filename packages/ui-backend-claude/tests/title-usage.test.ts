import { expect, test } from "bun:test";
import { ClaudeTitleUsageEvidence, createClaudeTitleUsageCollector } from "../src/title-usage.js";

function event(source: string | undefined, requestId = "req_odysseus", input = 3, output = 5, cost: number | null = 0.000084) {
  const attrs: Record<string, string | number | null | undefined> = { query_source: source, request_id: requestId,
    model: "claude-sonnet-4-6", "event.sequence": 3, input_tokens: input, output_tokens: output,
    cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: cost };
  return { resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: { stringValue: "claude_code.api_request" }, attributes:
    Object.entries(attrs).filter(([, value]) => value != null).map(([key, value]) => ({ key, value: typeof value === "string"
      ? { stringValue: value } : Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value } })) }] }] }] };
}

test("same-model main and child requests are never title helpers; duplicate exports retain helper cost once", () => {
  const evidence = new ClaudeTitleUsageEvidence();
  evidence.ingest(event("sdk", "req_main", 10, 20, 1));
  evidence.ingest(event("agent:general-purpose", "req_child", 100, 200, 2));
  const helper = event("generate_session_title");
  evidence.ingest(helper); evidence.ingest(helper);
  const snapshot = evidence.snapshot();
  expect(snapshot.coverage).toBe("observed");
  expect(snapshot.receipts, "TITLE_RECEIPT_EXCLUDES_MAIN_AND_CHILD").toHaveLength(1);
  expect(snapshot.receipts[0]!.receiptId).toBe("request:req_odysseus");
  expect(snapshot.receipts[0]!.usage.inputTokens, "MEASURED_HELPER_INPUT").toBe(3);
  expect(snapshot.receipts[0]!.costUsd, "MEASURED_HELPER_SPEND_RETAINED_ONCE").toBe(0.000084);
});

test("unavailable purpose and malformed counts are partial; absent helper cost stays unknown", () => {
  const evidence = new ClaudeTitleUsageEvidence();
  expect(evidence.snapshot().coverage, "NO_HELPER_RECEIPT_IS_UNKNOWN").toBe("unknown");
  evidence.ingest(event(undefined));
  evidence.ingest(event("generate_session_title", "req_invalid", -1));
  expect(evidence.snapshot()).toEqual({ receipts: [], coverage: "partial" });
  const unpriced = new ClaudeTitleUsageEvidence();
  unpriced.ingest(event("generate_session_title", "req_unpriced", 3, 5, null));
  expect(unpriced.snapshot().receipts[0]!.costUsd, "UNAVAILABLE_HELPER_COST_NOT_ZERO").toBeUndefined();
});

test("conflicting duplicate receipts preserve the first measured value and flag partial coverage", () => {
  const evidence = new ClaudeTitleUsageEvidence();
  evidence.ingest(event("generate_session_title"));
  evidence.ingest(event("generate_session_title", "req_odysseus", 30));
  expect(evidence.snapshot().coverage).toBe("partial");
  expect(evidence.snapshot().receipts[0]!.usage.inputTokens).toBe(3);
});

test("the local collector requires its per-process capability and accepts content-free OTLP", async () => {
  const collector = createClaudeTitleUsageCollector();
  try {
    const url = collector.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    const denied = await fetch(url, { method: "POST", body: JSON.stringify(event("generate_session_title")) });
    expect(denied.status, "COLLECTOR_REJECTS_UNAUTHORIZED_USAGE").toBe(401);
    expect(collector.snapshot().receipts).toHaveLength(0);
    const header = collector.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS.replace("Authorization=", "");
    const accepted = await fetch(url, { method: "POST", headers: { authorization: header }, body: JSON.stringify(event("generate_session_title")) });
    expect(accepted.status).toBe(200);
    expect(collector.snapshot().receipts).toHaveLength(1);
    expect(collector.env.OTEL_LOG_RAW_API_BODIES).toBe("0");
    expect(collector.env.OTEL_LOG_USER_PROMPTS).toBe("0");
  } finally { collector.stop(); }
});
