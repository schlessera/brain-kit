/** Real native 293/CLI/tool transport, only under the networkless launcher. */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { semanticCases, prepareSemantic } from "./workload";
import { installSurface, runNative, phase2Prompt } from "./native";
import { snapshot, assertInspectionUnchanged } from "./effects";
import { MODEL } from "./relay";
import { collectCurrent } from "./current";
import { admitExactPackets, type ReviewReceipt } from "./review-packet";

function response(id: number, content: { tool: string; input: unknown } | string) {
  const tool = typeof content !== "string";
  const block = tool ? { type: "tool_use", id: `tool_${id}`, name: content.tool, input: {} } : { type: "text", text: "" };
  const delta = tool ? { type: "input_json_delta", partial_json: JSON.stringify(content.input) } : { type: "text_delta", text: content };
  const frames = [
    { type: "message_start", message: { id: `msg_${id}`, type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: block },
    { type: "content_block_delta", index: 0, delta }, { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ];
  return new Response(frames.map(f => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

async function main() {
  if (process.env.BRAIN_CANONICAL_OFFLINE !== "1") throw Error("Only isolated offline probe");
  // Launcher unshares networking and has no non-loopback routes. Check the
  // supported Linux /proc boundary before touching even bogus native auth.
  const routes = readFileSync("/proc/net/route", "utf8").trim().split("\n").slice(1);
  if (routes.some(r => r.trim().split(/\s+/)[0] !== "lo")) throw Error("Offline namespace contains non-loopback route");
  const mode = process.argv[2] ?? "read", destination = process.argv[3];
  if (!["read", "finding", "cli", "write-denial", "review"].includes(mode)) throw Error("Unknown bounded offline control");
  const c = semanticCases.find(c => c.id === "t-exclusive-role")!, p = prepareSemantic(c);
  const output = mkdtempSync(join(tmpdir(), "canonical-native-receipts-"));
  let requests = 0, mainRequests = 0; const requestsBodies: unknown[] = [];
  try {
    installSurface(p.root, p.config);
    const before = snapshot(p.root), paths = Object.keys(p.files), toolResults: string[] = [];
    const options: Parameters<typeof runNative>[4] = {
      offline: true, readOnlyReview: mode === "review", ...(mode === "cli" ? { offlineDeadlineMs: 2000 } : {}), async fetch(_url, init) {
        const body = JSON.parse(new TextDecoder().decode(init.body as Uint8Array)); requests++; requestsBodies.push(body);
        if (body.model !== MODEL) throw Error("Fake upstream received unexpected model");
        if (mode === "review" && body.tools?.length) throw Error("No-tools review exposed tools");
        const isMain = mode === "review" || JSON.stringify(body).includes(phase2Prompt);
        for (const message of body.messages) for (const block of Array.isArray(message.content) ? message.content : [])
          if (block.type === "tool_result") toolResults.push(JSON.stringify(block.content));
        if (!isMain) return response(requests, "Offline helper control.");
        mainRequests++;
        if (mode === "write-denial" && mainRequests === 1) return response(requests, { tool: "Write", input: { file_path: join(p.root, paths[0]!), content: "This attempted source overwrite must be denied." } });
        if (mode === "cli" && mainRequests === 1) return response(requests, { tool: "Bash", input: { command: "brain config check --json" } });
        if (mode === "cli" && mainRequests === 2) return response(requests, { tool: "Bash", input: { command: "brain search navigator --json" } });
        if (["read", "finding"].includes(mode) && mainRequests <= 2) return response(requests, { tool: "Read", input: { file_path: join(p.root, paths[mainRequests - 1]!) } });
        return response(requests, mode === "review" ? "APPROVED" : mode === "finding" ? JSON.stringify([{ category: "conflict", path: paths[1], evidence: c.input.anchor, message: "The two records assign incompatible exclusive watch roles." }]) : "[]");
      },
    };
    const collected = mode === "finding" ? await collectCurrent(p.root, p.taxonomy, output, "sk-ant-oat01-offline-fixture-not-a-credential", options) : null;
    const result = collected?.native ?? await runNative(p.root, output, "sk-ant-oat01-offline-fixture-not-a-credential", mode === "review" ? "Return APPROVED for this scripted no-tools transport control." : phase2Prompt, options);
    // Assert effects FIRST so the intended write-denial mutation cannot be
    // hidden by a later tool-transcript/receipt assertion.
    assertInspectionUnchanged(before, collected?.inspected ?? snapshot(p.root));
    if (["read", "finding"].includes(mode) && !Object.values(p.files).every(raw => toolResults.some(r => r.includes(raw.split("\n").find(l => l.includes(" | Role | "))!)))) throw Error("Actual native Read did not return both fact files");
    if (collected && (collected.entries.length !== 1 || collected.entries[0]!.path !== paths[1] || collected.reconciliation.resolved !== 0)) throw Error("Actual native candidate did not reach persisted report-only reconciliation");
    if (mode === "write-denial" && !toolResults.some(r => r.includes("PreToolUse:Write hook error"))) throw Error("Actual Write denial absent");
    if (mode === "cli" && !toolResults.some(r => r.includes("navigator"))) throw Error("Actual indexed brain CLI search returned no fact");
    if (!requests || result.calls.length !== requests || result.receipt.init.claude_code_version !== "2.1.293" ||
      result.receipt.account.tokenSource !== "CLAUDE_CODE_OAUTH_TOKEN" || !result.receipt.drained || !result.receipt.stdoutComplete || result.calls.some(c => c.servedModel !== MODEL)) throw Error("Native identity/auth/raw-physical/drain assertion failed");
    let semanticAdmission: boolean | null = null;
    if (mode === "review") {
      const execution = JSON.parse(readFileSync(join(output, "execution.json"), "utf8"));
      if (execution.kind !== "offline-native-scripted" || execution.transport !== "injected-offline-fetch") throw Error("Actual offline execution provenance absent");
      const expected = { key: "offline-review", freezeSha: execution.freezeSha, promptSha: execution.promptSha, runtime: execution.runtime };
      const relabelled: ReviewReceipt = { ...expected, approved: true, model: MODEL, actualCli: "2.1.293", finished: true, drained: true,
        stdoutComplete: true, callsComplete: true, overage: "inactive observed", actualProvider: true,
        scope: "complementary-semantic-review", authorFamily: "gpt", reviewerFamily: "claude", evidence: result.evidence };
      semanticAdmission = admitExactPackets([expected], [relabelled]);
      if (semanticAdmission) throw Error("Actual scripted native APPROVED text acquired complementary semantic admission");
    }
    const receipt = { passed: true, mode, semanticAdmission, actualCli: "2.1.293", model: MODEL, fakePhysicalRequests: requests,
      actualNativeTools: mode !== "review", containedSourceUnchanged: true, childrenDrained: true, liveQuality: null, liveBilling: null,
      calls: result.calls, requestBodies: requestsBodies, native: result.receipt, currentCollector: collected ? { accepted: collected.accepted, invalid: collected.invalid, reconciliation: collected.reconciliation, entries: collected.entries, before: collected.before, inspected: collected.inspected, after: collected.after } : null };
    if (destination) { mkdirSync(join(destination, ".."), { recursive: true }); writeFileSync(destination, JSON.stringify(receipt, null, 2)); }
    console.log(JSON.stringify({ passed: true, mode, actualCli: "2.1.293", fakePhysicalRequests: requests, childrenDrained: true, externalRequests: 0 }));
  } finally {
    // Retain EVERY actual attempt, including failure stdout/usage/close, before
    // the disposable namespace and fixture are removed. These are private raw
    // controls, never a billing receipt or semantic approval.
    if (destination) {
      const raw = `${destination}.raw`; mkdirSync(raw, { recursive: true, mode: 0o700 });
      for (const name of ["execution.json", "review-evidence.json", "native.json", "native.json.stdin.jsonl", "native.json.stdout.jsonl", "native.json.stderr.bin", "physical.json", "paid.json", "paid-grant.json", "paid-refusal.json"])
        if (existsSync(join(output, name))) copyFileSync(join(output, name), join(raw, name));
      writeFileSync(join(raw, "request-bodies.json"), JSON.stringify(requestsBodies, null, 2), { mode: 0o600 });
    }
    p.close(); rmSync(output, { recursive: true, force: true });
  }
}
if (import.meta.main) await main();
