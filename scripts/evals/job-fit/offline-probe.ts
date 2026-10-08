/** Real native293 tool transport in a networkless namespace; scripted semantics are not quality. */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { benchmark } from "./benchmark";
import { prepare, observe } from "./brain";
import { installSurface, runNative } from "./native";
import { collectCurrent, completePrompt, inputPaths } from "./current";
import { MODEL } from "./relay";
import { admitExactPackets, type ReviewReceipt } from "./review-packet";

function response(id: number, content: { tool: string; input: unknown } | string) {
  const tool = typeof content !== "string";
  const block = tool ? { type: "tool_use", id: `tool_${id}`, name: content.tool, input: {} } : { type: "text", text: "" };
  const delta = tool ? { type: "input_json_delta", partial_json: JSON.stringify(content.input) } : { type: "text_delta", text: content };
  return new Response([
    { type: "message_start", message: { id: `msg_${id}`, type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: block }, { type: "content_block_delta", index: 0, delta },
    { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ].map(f => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
async function main() {
  if (process.env.BRAIN_JOB_FIT_OFFLINE !== "1") throw Error("Only isolated offline probe");
  const routes = readFileSync("/proc/net/route", "utf8").trim().split("\n").slice(1);
  if (routes.some(r => r.trim().split(/\s+/)[0] !== "lo")) throw Error("Offline namespace contains non-loopback route");
  const mode = process.argv[2] ?? "read", destination = process.argv[3];
  if (!["read", "assessment", "write-denial", "review", "wrong-evidence"].includes(mode)) throw Error("Unknown bounded offline control");
  const c = benchmark[0]!, p = await prepare(c), output = mkdtempSync(join(tmpdir(), "job-fit-native-receipts-"));
  const requestsBodies: any[] = []; let requests = 0, mainRequests = 0;
  try {
    const brainCli = installSurface(p.root, output), before = observe(p.root), toolResults: string[] = [];
    const options: Parameters<typeof runNative>[4] = { offline: true, readOnlyReview: mode === "review", async fetch(_url, init) {
      const body = JSON.parse(new TextDecoder().decode(init.body as Uint8Array)); requests++; requestsBodies.push(body);
      if (body.model !== MODEL || (mode === "review" && body.tools?.length)) throw Error("Fake upstream received wrong model/tools");
      const main = mode === "review" || JSON.stringify(body).includes("report-only assessment control");
      for (const message of body.messages) for (const block of Array.isArray(message.content) ? message.content : [])
        if (block.type === "tool_result") toolResults.push(JSON.stringify(block.content));
      if (!main) return response(requests, "Offline helper control.");
      mainRequests++;
      if (mode === "write-denial" && mainRequests === 1) return response(requests, { tool: "Write", input: { file_path: join(p.root, inputPaths[2]), content: "Unreviewed opportunity overwrite must be denied." } });
      if (["read", "assessment", "wrong-evidence"].includes(mode) && mainRequests === 1) return response(requests, { tool: "Read", input: { file_path: join(p.root, inputPaths[2]) } });
      return response(requests, mode === "review" ? "APPROVED" : JSON.stringify({ passage: "met", relocation: "not_met", recommendation: "pursue", explanation: "The supplied role plans sea courses and permits Ithaca residence; no application decision is made.",
        alignment: ["The supplied identity describes sea-captain experience."], gaps: ["Further expertise is not documented."], companyKnown: ["Role facts are in the complete posting."],
        companyUnknown: ["funding", "team size", "leadership", "hiring history"], evidencePaths: mode === "wrong-evidence" ? [...inputPaths, "tablets/sentinel.md"] : [...inputPaths] }));
    } };
    const collected = ["assessment", "wrong-evidence"].includes(mode) ? await collectCurrent(p.root, output, "sk-ant-oat01-offline-fixture-not-a-credential", options) : null;
    if (collected) writeFileSync(join(output, "current-assessment.json"), JSON.stringify({ raw: collected.raw, parsed: collected.parsed, accepted: collected.accepted, invalid: collected.invalid,
      authority: collected.authority, applicationDecision: collected.applicationDecision, writes: collected.writes, fullResearchWorkflowMeasured: collected.fullResearchWorkflowMeasured }, null, 2), { mode: 0o600 });
    const result = collected?.native ?? await runNative(p.root, output, "sk-ant-oat01-offline-fixture-not-a-credential", mode === "review" ? "Return APPROVED for this scripted no-tools transport control." : completePrompt(p.root), options);
    // Effects first: an intended Write-denial mutation must fail on actual fixture state.
    if (JSON.stringify(observe(p.root)) !== JSON.stringify(before)) throw Error("Native report-only job assessment changed whole fixture state");
    if (["read", "assessment", "wrong-evidence"].includes(mode) && !toolResults.some(r => typeof JSON.parse(r) === "string" && JSON.parse(r).replace(/^\d+\t/gm, "") === readFileSync(join(p.root, inputPaths[2]), "utf8"))) throw Error("Actual native Read did not return complete posting");
    if (mode === "write-denial" && !toolResults.some(r => r.includes("PreToolUse:Write hook error"))) throw Error("Actual Write denial absent");
    if (collected && mode === "wrong-evidence" && (collected.accepted !== null || !collected.invalid)) throw Error("Unsupported native assessment must have zero admitted report");
    if (collected && mode !== "wrong-evidence" && (!collected.accepted || collected.invalid || collected.authority !== null || collected.applicationDecision !== null || collected.writes.length || collected.fullResearchWorkflowMeasured)) throw Error("Report-only native control lost valid observation or acquired authority/full-baseline claim");
    if (!requests || result.calls.length !== requests || result.receipt.init.claude_code_version !== "2.1.293" || result.receipt.account.tokenSource !== "CLAUDE_CODE_OAUTH_TOKEN" || !result.receipt.drained || !result.receipt.stdoutComplete || result.calls.some(call => call.servedModel !== MODEL)) throw Error("Native identity/auth/physical/drain control failed");
    let semanticAdmission: boolean | null = null;
    if (mode === "review") {
      const execution = JSON.parse(readFileSync(join(output, "execution.json"), "utf8"));
      if (execution.kind !== "offline-native-scripted" || execution.transport !== "injected-offline-fetch") throw Error("Actual offline provenance absent");
      const expected = { key: "offline-review", freezeSha: execution.freezeSha, promptSha: execution.promptSha, runtime: execution.runtime };
      const relabelled: ReviewReceipt = { ...expected, approved: true, model: MODEL, actualCli: "2.1.293", finished: true, drained: true, stdoutComplete: true, callsComplete: true,
        overage: "inactive observed", actualProvider: true, scope: "complementary-semantic-review", authorFamily: "gpt", reviewerFamily: "claude", evidence: result.evidence };
      semanticAdmission = admitExactPackets([expected], [relabelled]);
      if (semanticAdmission) throw Error("Actual scripted native APPROVED text acquired complementary semantic admission");
    }
    const receipt = { passed: true, mode, actualCli: "2.1.293", model: MODEL, fakePhysicalRequests: requests, brainCli, native: result.receipt, calls: result.calls,
      currentAccepted: collected?.accepted ?? null, authority: null, applicationDecision: null, fullResearchWorkflowMeasured: false,
      childrenDrained: true, containedSourceUnchanged: true, semanticAdmission, liveQuality: null, liveBilling: null };
    if (destination) writeFileSync(destination, JSON.stringify(receipt, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ passed: true, mode, actualCli: "2.1.293", fakePhysicalRequests: requests, externalRequests: 0, childrenDrained: true }));
  } finally {
    if (destination) {
      const raw = `${destination}.raw`; mkdirSync(raw, { recursive: true, mode: 0o700 });
      for (const name of ["execution.json", "review-evidence.json", "native.json", "native.json.stdin.jsonl", "native.json.stdout.jsonl", "native.json.stderr.bin", "physical.json", "brain-cli-preparation.json", "current-assessment.json"])
        if (existsSync(join(output, name))) copyFileSync(join(output, name), join(raw, name));
      writeFileSync(join(raw, "request-bodies.json"), JSON.stringify(requestsBodies, null, 2), { mode: 0o600 });
    }
    p.close(); rmSync(output, { recursive: true, force: true });
  }
}
if (import.meta.main) await main();
