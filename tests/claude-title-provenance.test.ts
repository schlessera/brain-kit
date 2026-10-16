import { expect, test } from "bun:test";
import { captureTitleProvenance } from "../experiments/2052-title-provenance/run.js";

test("installed Claude new/resume capture keeps title generation enabled and correlates response receipts", async () => {
  const report = await captureTitleProvenance();
  expect(report.sdkVersion).toBeTruthy();
  expect(report.cliVersion).toBeTruthy();
  expect(report.turns).toHaveLength(2);
  for (const turn of report.turns) {
    expect(turn.sameSession, "RESUME_USES_ORIGINAL_SESSION").toBe(true);
    expect(turn.titleOptionPresent, "TITLE_GENERATION_NOT_SUPPRESSED").toBe(false);
    const result = turn.messages.find((message: any) => message.type === "result");
    expect(result?.subtype, "SUCCESSFUL_RUNTIME_RESULT").toBe("success");
    const starts = turn.messages.filter((message: any) => message.event === "message_start");
    expect(starts.length, "OBSERVED_RESPONSE_RECEIPT").toBeGreaterThan(0);
    for (const message of starts) {
      const request = report.requests.find((request: any) => request.responseId === message.response.id);
      expect(request?.turn, "STREAM_RECEIPT_MATCHES_REQUEST").toBe(turn.turn);
      expect(message.response.usage.input_tokens).toBe(3);
    }
  }
  expect(report.transcriptTypes.user, "SAVED_NEW_AND_RESUMED_PROMPTS").toBe(2);
  expect(report.turns[0].titleUsage.coverage).toBe("observed");
  expect(report.turns[0].titleUsage.receipts).toHaveLength(1);
  expect(report.turns[0].titleUsage.receipts[0].source, "RUNTIME_TITLE_SOURCE").toBe("generate_session_title");
  expect(report.turns[0].titleUsage.receipts[0].usage.perModel["claude-sonnet-4-6"].inputTokens, "SAME_MODEL_HELPER_USAGE").toBe(3);
  expect(report.turns[1].titleUsage.receipts, "RESUME_DOES_NOT_EMIT_TITLE_AGAIN").toHaveLength(0);
  // The fake endpoint proves local runtime attribution, not provider invoices.
}, 180_000);


test("the nonessential-traffic control explains an absent helper without assigning free usage", async () => {
  const report = await captureTitleProvenance(true);
  expect(report.requests).toHaveLength(2);
  expect(report.transcriptTypes["ai-title"] ?? 0).toBe(0);
  for (const turn of report.turns) {
    expect(turn.titleUsage.receipts).toHaveLength(0);
    expect(turn.titleUsage.coverage, "NO_RECEIPT_IS_UNKNOWN_NOT_FREE").toBe("unknown");
  }
}, 180_000);
