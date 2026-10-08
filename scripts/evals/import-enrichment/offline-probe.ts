/** Actual native293 and writer transport controls in a networkless namespace, not semantic quality. */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { benchmark, prepare, execute } from "./benchmark";
import { observe, assertEffects, assertPreservation } from "./effects";
import { installSurface, runNative, assessmentPrompt } from "./native";
import { generator } from "./generation";
import { observedClient } from "./jev-observer";
import { classifier } from "./classification";
import { MODEL } from "./relay";
import { admitExactPackets, type ReviewReceipt } from "./review-packet";
function response(id: number, content: string | { tool: string; input: unknown }) {
  const tool = typeof content !== "string";
  return new Response([
    { type: "message_start", message: { id: `msg_${id}`, type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: tool ? { type: "tool_use", id: `tool_${id}`, name: content.tool, input: {} } : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(content.input) } : { type: "text_delta", text: content } },
    { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } }, { type: "message_stop" },
  ].map(f => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
async function main() {
  if (process.env.BRAIN_IMPORT_ENRICHMENT_OFFLINE !== "1" || readFileSync("/proc/net/route", "utf8").trim().split("\n").slice(1).some(r => r.trim().split(/\s+/)[0] !== "lo")) throw Error("Only networkless native controls");
  const mode = process.argv[2] ?? "read", destination = process.argv[3];
  if (!["read", "generation", "hybrid", "custom-inbox", "write-denial", "review"].includes(mode)) throw Error("Unknown offline control");
  const c = mode === "custom-inbox" ? benchmark.find(c => c.customInbox)! : benchmark[0]!, env = prepare(c, mode === "hybrid" ? "hybrid" : "combined"), output = mkdtempSync(join(tmpdir(), "import-native-receipts-"));
  const bodies: unknown[] = [], toolResults: string[] = []; let requests = 0;
  try {
    const approvedConfig = env.files["brain.config.json"]!, approvedConfigState = observe(env.root)["brain.config.json"];
    const brainCli = installSurface(env.root, output), before = observe(env.root);
    if (readFileSync(join(env.root, "brain.config.json"), "utf8") !== approvedConfig) throw Error("Native setup overwrote frozen per-case taxonomy");
    if (JSON.stringify(before["brain.config.json"]) !== JSON.stringify(approvedConfigState)) throw Error("Native setup changed frozen taxonomy mode or clock");
    const effective = JSON.parse(brainCli.find(r => r.args[0] === "config")!.stdout).taxonomy;
    if (effective.inbox !== env.taxonomy.inboxType() || (mode === "custom-inbox" && (effective.types.entry?.dir !== "incoming" || effective.types.note?.dir !== "notes"))) throw Error("Actual CLI effective taxonomy differs from approved per-case inputs");
    const input = { source: env.files[env.path], approvedFiles: env.settings.files, typeDefinitions: env.settings.typeDefinitions, tagDefinitions: env.settings.tagDefinitions, taxonomyConfig: JSON.parse(approvedConfig) };
    const prompt = mode === "custom-inbox" ? assessmentPrompt + "\n\nAPPROVED INPUTS AND UNTRUSTED COMPLETE SOURCE\n" + JSON.stringify(input) : assessmentPrompt;
    const options: Parameters<typeof runNative>[4] = { offline: true, readOnlyReview: mode === "review", async fetch(_url, init) {
      const body = JSON.parse(new TextDecoder().decode(init.body as Uint8Array)); bodies.push(body); requests++;
      if (body.model !== MODEL || (mode === "review" && body.tools?.length)) throw Error("Wrong native model/tools");
      for (const message of body.messages) for (const block of Array.isArray(message.content) ? message.content : []) if (block.type === "tool_result") toolResults.push(JSON.stringify(block.content));
      if (mode === "write-denial" && requests === 1) return response(requests, { tool: "Write", input: { file_path: join(env.root, env.path), content: "Untrusted enrichment overwrite must be refused." } });
      if (mode !== "review" && mode !== "write-denial" && requests === 1) return response(requests, { tool: "Read", input: { file_path: join(env.root, env.path) } });
      return response(requests, mode === "review" ? "APPROVED" : JSON.stringify(mode === "hybrid" ? { summary: c.summary } : { type: c.type, tags: c.tags, summary: c.summary }));
    } };
    let result: Awaited<ReturnType<typeof runNative>>, logicalGenerations = 1, classificationCalls = 0;
    if (mode === "generation" || mode === "hybrid") {
      const generated = generator(env.root, output, "sk-ant-oat01-offline-fixture-not-a-credential", options);
      const jev = observedClient(async () => { const answer = (choice: string, choices: string[]) => ({ type: "choice", choice, confidence: 1, probabilities: Object.fromEntries(choices.map(o => [o, o === choice ? 1 : 0])) });
        return Response.json({ model: "jev-1.13.0", answers: { documentType: answer("logbook", ["note", "logbook", "ruling", "unclear"]), tag0: answer("yes", ["yes", "no", "unclear"]), tag1: answer("no", ["yes", "no", "unclear"]), tag2: answer("no", ["yes", "no", "unclear"]) }, usage: { input_tokens: 321, output_tokens: 19 } }); });
      const written = await execute(env, mode === "hybrid" ? { classifier: classifier(jev, .9), summary: generated.provider } : { classifier: generated.provider });
      writeFileSync(join(output, "jev-physical.json"), JSON.stringify(jev.calls, null, 2), { mode: 0o600 });
      writeFileSync(join(output, "writer-result.json"), JSON.stringify(written, null, 2), { mode: 0o600 });
      if (written.failed.length || written.written.length !== 1 || generated.attempts.some(a => a.failure || !a.observed)) throw Error("Actual retained generation did not reach preserving writer");
      const raw = readFileSync(join(env.root, env.path), "utf8"); if (raw !== env.expected[env.path]) throw Error("Actual native writer full file differs from independent expected bytes");
      assertPreservation(env.files[env.path]!, raw, env.settings.files[0]!.mutable); assertEffects(before, observe(env.root), env.settings, written.written);
      const after = observe(env.root), calls = requests, again = await execute(env, mode === "hybrid" ? { classifier: classifier(jev, .9), summary: generated.provider } : { classifier: generated.provider });
      if (requests !== calls || again.written.length || JSON.stringify(observe(env.root)) !== JSON.stringify(after)) throw Error("Completed native generation replay made calls or churned state");
      result = generated.attempts[0]!.observed!; logicalGenerations = generated.attempts.length; classificationCalls = jev.calls.length;
    } else {
      result = await runNative(env.root, output, "sk-ant-oat01-offline-fixture-not-a-credential", mode === "review" ? "Return APPROVED for this scripted no-tools transport control." : prompt, options);
      if (JSON.stringify(observe(env.root)) !== JSON.stringify(before)) throw Error("Native report-only import control changed whole fixture state");
    }
    if (["read", "generation", "hybrid", "custom-inbox"].includes(mode) && !toolResults.some(r => JSON.parse(r).replace(/^\d+\t/gm, "") === env.files[env.path])) throw Error("Native Read did not return full unchanged source");
    if (mode === "custom-inbox" && !bodies.some(body => (body as { messages: Array<{ content: string | Array<{ text?: string }> }> }).messages.some(message =>
      (typeof message.content === "string" ? message.content : message.content.map(block => block.text ?? "").join("\n")).includes(prompt)))) throw Error("Actual native request omitted frozen custom inbox/source/approved inputs");
    if (mode === "write-denial" && !toolResults.some(r => r.includes("PreToolUse:Write hook error"))) throw Error("Actual Write denial absent");
    if (!requests || !result.receipt.drained || !result.receipt.stdoutComplete || result.receipt.init.claude_code_version !== "2.1.293") throw Error("Native raw closure/runtime absent");
    let semanticAdmission: boolean | null = null;
    if (mode === "review") {
      const execution = JSON.parse(readFileSync(join(output, "execution.json"), "utf8")), expected = { key: "offline-review", freezeSha: execution.freezeSha, promptSha: execution.promptSha, runtime: execution.runtime };
      const labelled: ReviewReceipt = { ...expected, approved: true, model: MODEL, actualCli: "2.1.293", finished: true, drained: true, stdoutComplete: true, callsComplete: true, overage: "inactive observed", actualProvider: true, scope: "complementary-semantic-review", authorFamily: "gpt", reviewerFamily: "claude", evidence: result.evidence };
      semanticAdmission = admitExactPackets([expected], [labelled]); if (semanticAdmission) throw Error("Actual scripted native APPROVED acquired semantic admission");
    }
    if (destination) writeFileSync(destination, JSON.stringify({ passed: true, mode, actualCli: "2.1.293", fakeNativePhysicalRequests: requests, fakeClassificationPhysicalRequests: classificationCalls, logicalGenerations, externalRequests: 0, childrenDrained: true, brainCli, ...(mode === "custom-inbox" ? { approvedTaxonomyConfig: JSON.parse(approvedConfig), effectiveTaxonomy: effective, nativePrompt: prompt, wholeUnapprovedEffectsUnchanged: true } : {}), native: result.receipt, semanticAdmission, completeCurrentStage3Measured: false, invoiceUsd: null }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ passed: true, mode, fakeNativePhysicalRequests: requests, fakeClassificationPhysicalRequests: classificationCalls, externalRequests: 0, childrenDrained: true }));
  } finally {
    if (destination) { const raw = `${destination}.raw`; mkdirSync(raw, { recursive: true, mode: 0o700 });
      function preserve(directory: string, target: string) { mkdirSync(target, { recursive: true, mode: 0o700 }); for (const entry of readdirSync(directory, { withFileTypes: true })) { const from = join(directory, entry.name), to = join(target, entry.name); if (entry.name === "home") continue; if (entry.isDirectory()) preserve(from, to); else if (entry.isFile()) copyFileSync(from, to); } }
      preserve(output, raw); writeFileSync(join(raw, "native-request-bodies.json"), JSON.stringify(bodies, null, 2), { mode: 0o600 });
    }
    env.close(); rmSync(output, { recursive: true, force: true });
  }
}
if (import.meta.main) await main();
