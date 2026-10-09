/** Real native 293/CLI/tool transport, only under the networkless launcher. */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixtures, prepare } from "./fixtures";
import { installSurface, runNative, tagNoisePrompt } from "./native";
import { snapshot } from "./prototype";
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
  if (process.env.BRAIN_TAG_ALIAS_OFFLINE !== "1") throw Error("Only isolated offline probe");
  // Launcher unshares networking and has no non-loopback routes. Check the
  // supported Linux /proc boundary before touching even bogus native auth.
  const routes = readFileSync("/proc/net/route", "utf8").trim().split("\n").slice(1);
  if (routes.some(r => r.trim().split(/\s+/)[0] !== "lo")) throw Error("Offline namespace contains non-loopback route");
  const mode = process.argv[2] ?? "read", destination = process.argv[3];
  if (!["read", "proposal", "cli", "write-denial", "review", "unsupported-target", "wrong-evidence"].includes(mode)) throw Error("Unknown bounded offline control");
  const c = fixtures.find(c => c.id === "ogygia-harbour")!, p = prepare(c);
  const output = mkdtempSync(join(tmpdir(), "tag-alias-native-receipts-"));
  let requests = 0, mainRequests = 0; const requestsBodies: unknown[] = [];
  try {
    if (mode === "unsupported-target") p.config.taxonomy.tags.vocabulary.push(c.left);
    installSurface(p.root, p.config);
    const before = snapshot(p.root), paths = p.paths, toolResults: string[] = [];
    const options: Parameters<typeof runNative>[4] = {
      offline: true, readOnlyReview: mode === "review", ...(mode === "cli" ? { offlineDeadlineMs: 2000 } : {}), async fetch(_url, init) {
        const body = JSON.parse(new TextDecoder().decode(init.body as Uint8Array)); requests++; requestsBodies.push(body);
        if (body.model !== MODEL) throw Error("Fake upstream received unexpected model");
        if (mode === "review" && body.tools?.length) throw Error("No-tools review exposed tools");
        const isMain = mode === "review" || JSON.stringify(body).includes(tagNoisePrompt);
        for (const message of body.messages) for (const block of Array.isArray(message.content) ? message.content : [])
          if (block.type === "tool_result") toolResults.push(JSON.stringify(block.content));
        if (!isMain) return response(requests, "Offline helper control.");
        mainRequests++;
        if (mode === "write-denial" && mainRequests === 1) return response(requests, { tool: "Write", input: { file_path: join(p.root, paths[0]!), content: "This attempted source overwrite must be denied." } });
        if (mode === "cli" && mainRequests === 1) return response(requests, { tool: "Bash", input: { command: "brain config check --json" } });
        if (mode === "cli" && mainRequests === 2) return response(requests, { tool: "Bash", input: { command: "brain search harbour --json" } });
        if (["read", "proposal", "unsupported-target", "wrong-evidence"].includes(mode) && mainRequests <= 2) return response(requests, { tool: "Read", input: { file_path: join(p.root, paths[mainRequests - 1]!) } });
        return response(requests, mode === "review" ? "APPROVED" : ["proposal", "unsupported-target", "wrong-evidence"].includes(mode) ? JSON.stringify([{ from: c.left, to: c.right, reason: "Both usages describe the same sheltered landing place.", documents: mode === "wrong-evidence" ? [...paths, "excluded/kept.md"] : paths }]) : "[]");
      },
    };
    const collected = ["proposal", "unsupported-target", "wrong-evidence"].includes(mode) ? await collectCurrent(p.root, output, "sk-ant-oat01-offline-fixture-not-a-credential", options) : null;
    if (collected && destination) {
      mkdirSync(`${destination}.raw`, { recursive: true, mode: 0o700 });
      writeFileSync(join(`${destination}.raw`, "current-proposals.json"), JSON.stringify({ raw: collected.raw, accepted: collected.accepted, invalid: collected.invalid,
        explicitReview: collected.explicitReview, applied: collected.applied }, null, 2), { mode: 0o600 });
    }
    const result = collected?.native ?? await runNative(p.root, output, "sk-ant-oat01-offline-fixture-not-a-credential", mode === "review" ? "Return APPROVED for this scripted no-tools transport control." : tagNoisePrompt, options);
    // Assert effects FIRST so the intended write-denial mutation cannot be
    // hidden by a later tool-transcript/receipt assertion.
    const after=collected?.after??snapshot(p.root);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      writeFileSync(join(output,"inspection-effects.json"),JSON.stringify({before,after},null,2),{mode:0o600});
      throw Error("Unexpected inspection effects in report-only tag review");
    }
    if (["read", "proposal", "unsupported-target", "wrong-evidence"].includes(mode) && !paths.every(path => toolResults.some(r => typeof JSON.parse(r) === "string" && JSON.parse(r).replace(/^\d+\t/gm, "") === p.files[path]))) throw Error("Actual native Read did not return both complete tag-usage files");
    if (collected && ["unsupported-target", "wrong-evidence"].includes(mode)) {
      if (collected.accepted.length !== 0) throw Error(`Unsupported native proposal must have zero admitted rows; received ${collected.accepted.length}`);
      if (collected.raw.length !== 1 || collected.invalid.length !== 1) throw Error("Actual unsupported native proposal not retained separately from admission");
      if (collected.applied || collected.explicitReview !== null) throw Error("Native proposal acquired explicit review/write authority");
    } else if (collected && (collected.accepted.length !== 1 || collected.accepted[0]!.from !== c.left || collected.accepted[0]!.to !== c.right || collected.applied || collected.explicitReview !== null)) throw Error("Actual current proposal did not reach code admission or acquired write authority");
    if (mode === "write-denial" && !toolResults.some(r => r.includes("PreToolUse:Write hook error"))) throw Error("Actual Write denial absent");
    if (mode === "cli" && !toolResults.some(r => r.includes("harbour"))) throw Error("Actual indexed brain CLI search returned no fact");
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
      calls: result.calls, requestBodies: requestsBodies, native: result.receipt, currentCollector: collected ? { accepted: collected.accepted, invalid: collected.invalid, explicitReview: collected.explicitReview, applied: collected.applied, before: collected.before, after: collected.after } : null };
    if (destination) { mkdirSync(join(destination, ".."), { recursive: true }); writeFileSync(destination, JSON.stringify(receipt, null, 2)); }
    console.log(JSON.stringify({ passed: true, mode, actualCli: "2.1.293", fakePhysicalRequests: requests, childrenDrained: true, externalRequests: 0 }));
  } finally {
    // Retain EVERY actual attempt, including failure stdout/usage/close, before
    // the disposable namespace and fixture are removed. These are private raw
    // controls, never a billing receipt or semantic approval.
    if (destination) {
      const raw = `${destination}.raw`; mkdirSync(raw, { recursive: true, mode: 0o700 });
      for (const name of ["execution.json", "review-evidence.json", "native.json", "native.json.stdin.jsonl", "native.json.stdout.jsonl", "native.json.stderr.bin", "physical.json","paid.json","paid-grant.json","paid-refusal.json","inspection-effects.json"])
        if (existsSync(join(output, name))) copyFileSync(join(output, name), join(raw, name));
      writeFileSync(join(raw, "request-bodies.json"), JSON.stringify(requestsBodies, null, 2), { mode: 0o600 });
    }
    p.close(); rmSync(output, { recursive: true, force: true });
  }
}
if (import.meta.main) await main();
