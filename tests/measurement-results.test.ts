import { expect, test } from "bun:test";
import { runTurn, report, costRows } from "../scripts/measure-show-block";
import { MeasurementResults, priceCoverage } from "../scripts/measurement-results";
import type { query as Query } from "@anthropic-ai/claude-agent-sdk";

const sdkEntry = Bun.resolveSync("@anthropic-ai/claude-agent-sdk", new URL("../packages/ui-backend-claude/src", import.meta.url).pathname);
const { query } = await import(sdkEntry) as typeof import("@anthropic-ai/claude-agent-sdk");
const receipt = {
  type: "result", subtype: "error_max_budget_usd", is_error: true, duration_ms: 2, duration_api_ms: 1,
  num_turns: 2, total_cost_usd: .375,
  usage: { input_tokens: 101, output_tokens: 37, cache_creation_input_tokens: 203, cache_read_input_tokens: 307 },
  modelUsage: { "claude-sonnet-5-5": { inputTokens: 401, outputTokens: 73, cacheCreationInputTokens: 503, cacheReadInputTokens: 607, costUSD: .375 } },
  permission_denials: [], errors: ["Reached maximum budget; Ὀδυσσεύς"], session_id: "fixture-session", uuid: "fixture-result",
};
const fakeNative = `
import { createInterface } from "node:readline";
const result = JSON.parse(process.argv[1]);
for await (const line of createInterface({ input: process.stdin })) {
 const frame = JSON.parse(line);
 if (frame.type === "control_request") process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response: { commands: [], models: [], account: {} } } }) + "\\n");
 if (frame.type === "user") {
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-5-5", claude_code_version: "fixture-native", apiKeySource: "none" }) + "\\n");
  if (result === null) process.exit(1);
  const bytes = Buffer.from(JSON.stringify(result));
  for (let i = 0; i < bytes.length; i++) {
   process.stdout.write(bytes.subarray(i, i + 1));
   await new Promise(resolve => setTimeout(resolve, 1));
  }
  if (process.argv[2] === "newline") process.stdout.write("\\n");
  await new Promise(resolve => setTimeout(resolve, 10));
  process.exit(result.is_error ? 1 : 0);
 }
}
`;
function controlled(result: object | null, terminated = true, rejectBeforeYield = false): typeof Query {
  return ((params: Parameters<typeof Query>[0]) => {
    const stream = query({ ...params, options: { ...params.options,
    spawnClaudeCodeProcess: options => params.options!.spawnClaudeCodeProcess!({ ...options,
      command: process.execPath, args: ["-e", fakeNative, JSON.stringify(result), terminated ? "newline" : "unterminated"],
      env: { PATH: process.env.PATH, HOME: params.options!.cwd, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    }),
    } });
    if (!rejectBeforeYield) return stream;
    // Exercise a consumer that rejects a parsed result before the reporting
    // iterator receives it. The real SDK still drives the native transport.
    return {
      async *[Symbol.asyncIterator]() {
        for await (const message of stream) {
          if (message.type === "result") throw Error("controlled consumer rejected result before yield");
          yield message;
        }
      },
      close: () => stream.close(),
    };
  }) as typeof Query;
}
const prompt = { id: "fixture", invites: "quote", classifiable: true, text: "Record the fictional observation." };

for (const terminated of [true, false]) test(`real SDK rejects ${terminated ? "terminated" : "unterminated"} native error-result but retains nonzero receipt and main-loop counters`, async () => {
  const turn = await runTurn(prompt, "brief", 1, true, controlled(receipt, terminated));
  // Exit/read scheduling determines whether the SDK consumed the final frame.
  expect(turn.error).toMatch(/Claude Code (returned an error result|process exited with code 1)/);
  expect(turn.costUsd).toBe(.375);
  expect(turn.nativeProcesses).toEqual([{ closed: true, stdoutFinished: true, code: 1, signal: null, forcedKill: false }]);
  expect(turn.receiptSource).toBe("native");
  expect(turn.resultReceipts).toEqual([receipt]);
  expect([turn.inputTokens, turn.outputTokens, turn.cacheCreationTokens, turn.cacheReadTokens, turn.modelTurns]).toEqual([101, 37, 203, 307, 2]);
  const text = report([turn], null, 1, { source: "CLAUDE_CODE_OAUTH_TOKEN", headers: {} }, []);
  expect(text).toContain("price receipts: 1/1; known subtotal $0.38; total $0.38");
  expect(costRows([turn]).join("\n")).toContain("unknown/not measured");
}, 20_000);

test("a consumer rejects the real SDK result before reporting sees it; native nonzero usage survives", async () => {
  const turn = await runTurn(prompt, "brief", 1, true, controlled(receipt, true, true));
  expect(turn.error).toBe("controlled consumer rejected result before yield");
  expect(turn.costUsd).toBe(.375);
  expect(turn.resultReceipts).toEqual([receipt]);
  expect([turn.inputTokens, turn.outputTokens, turn.cacheCreationTokens, turn.cacheReadTokens, turn.modelTurns]).toEqual([101, 37, 203, 307, 2]);
  expect(turn.nativeProcesses.every(process => process.closed && process.stdoutFinished)).toBe(true);
  expect(costRows([turn]).join("\n")).toContain("unknown/not measured");
}, 20_000);

test("a missing result stays unknown and cannot become a zero price or complete subtotal", async () => {
  const empty = (() => ({ async *[Symbol.asyncIterator]() {} })) as unknown as typeof Query;
  const turn = await runTurn(prompt, "brief", 1, true, empty);
  expect(turn.error).toBe("missing_result");
  expect(turn.resultReceipts).toEqual([]);
  expect([turn.costUsd, turn.inputTokens, turn.outputTokens, turn.cacheCreationTokens, turn.cacheReadTokens, turn.modelTurns]).toEqual([null, null, null, null, null, null]);
  expect(priceCoverage([{ costUsd: .375 }, turn])).toEqual({ known: 1, missing: 1, knownSubtotalUsd: .375, totalUsd: null });
  expect(report([turn], null, 1, { source: "CLAUDE_CODE_OAUTH_TOKEN", headers: {} }, [])).toContain("price receipts: 0/1; known subtotal $0.00; total unknown");
});

test("a real native failure without any result cannot fabricate a zero-cost receipt", async () => {
  const turn = await runTurn(prompt, "brief", 1, true, controlled(null));
  expect(turn.error).toContain("Claude Code process exited with code 1");
  expect(turn.nativeProcesses).toEqual([{ closed: true, stdoutFinished: true, code: 1, signal: null, forcedKill: false }]);
  expect(turn.resultReceipts).toEqual([]);
  expect(turn.receiptSource).toBe("none");
  expect(turn.costUsd).toBeNull();
  expect(priceCoverage([turn]).totalUsd).toBeNull();
}, 20_000);

test("drain timeout force-kills and awaits an owned native child ignoring SIGTERM", async () => {
  const observed = new MeasurementResults();
  const child = observed.spawn({ command: process.execPath, args: ["-e", 'process.on("SIGTERM",()=>{});process.stdout.write("ready\\n");setInterval(()=>{},1000);'],
    env: { PATH: process.env.PATH }, signal: new AbortController().signal,
  });
  const output = child.stdout[Symbol.asyncIterator]();
  // Keep the deliberate missing-kill mutation bounded without hiding its receipt.
  let watchdog = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    expect(String((await output.next()).value)).toContain("ready");
    clearTimeout(watchdog);
    watchdog = setTimeout(() => child.kill("SIGKILL"), 500);
    child.kill("SIGTERM");
    expect(await observed.drain(50)).toBe(false);
    expect(observed.processes).toEqual([{ closed: true, stdoutFinished: true, code: null, signal: "SIGKILL", forcedKill: true }]);
    expect(child.signalCode).toBe("SIGKILL");
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await observed.drain(50);
  }
}, 20_000);

test("successful native receipt retains successful usage and remains in the answer denominator", async () => {
  const success = { ...receipt, subtype: "success", is_error: false, result: "Recorded the observation.", errors: [] };
  const turn = await runTurn(prompt, "brief", 1, true, controlled(success));
  expect(turn.error).toBeUndefined();
  expect(turn.nativeProcesses[0]!.code).toBe(0);
  expect(turn.costUsd).toBe(.375); expect(turn.inputTokens).toBe(101);
  expect(costRows([turn]).join("\n")).toContain("$0.375");
}, 20_000);
