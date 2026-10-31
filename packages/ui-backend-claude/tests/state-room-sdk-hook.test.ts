import { createFixtureWorkerStartupView } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
/** Real installed SDK hook transport and actual isolated worker, with a keyless native protocol fixture. */
import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createClaudeBackend } from "../src/backend.js";
import { processStateLedger } from "../src/worker-state-budget.js";

// Spy on the runtime namespace so named production imports are observed too.
const fs = await import("node:fs");

const SESSION = "11111111-1111-4111-8111-111111111111";
const runtime = `
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
const copiedBytes = readFileSync(process.env.CLAUDE_CONFIG_DIR + "/" + process.env.PROJECT + "/" + process.argv[1] + ".jsonl").byteLength;
if (copiedBytes !== Number(process.env.EXPECTED_BYTES)) throw new Error("STATE_ROOM_NATIVE_COPIED_BYTES: " + copiedBytes);
const session = process.argv[1]; let callback;
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
setTimeout(()=>{console.error("Keyless SDK fixture did not finish its protocol exchange");process.exit(1)},20000);
for await (const line of createInterface({input:process.stdin})) {
 const frame=JSON.parse(line);
 if(frame.type==="control_request" && frame.request.subtype==="initialize") {
  callback=frame.request.hooks.UserPromptSubmit.at(-1).hookCallbackIds[0];
  send({type:"control_response",response:{subtype:"success",request_id:frame.request_id,response:{commands:[],models:[],account:{tokenSource:"CLAUDE_CODE_OAUTH_TOKEN",apiProvider:"firstParty"}}}});
 } else if(frame.type==="control_request") {
  send({type:"control_response",response:{subtype:"success",request_id:frame.request_id,response:{settings:{},sources:[]}}});
 } else if(frame.type==="user") {
  send({type:"system",subtype:"init",session_id:session,model:"claude-sonnet-5-5",claude_code_version:"fixture-native",apiKeySource:"none"});
  send({type:"control_request",request_id:"odysseus-state-warning-hook",request:{subtype:"hook_callback",callback_id:callback,input:{hook_event_name:"UserPromptSubmit",session_id:session,cwd:process.cwd(),transcript_path:"",prompt:"Return to Ithaca"}}});
 } else if(frame.type==="control_response" && frame.response.request_id==="odysseus-state-warning-hook") {
  const output=frame.response.response;
  if (Number(process.env.EXPECTED_BYTES) > 60 * 4096) {
    if (output.hookSpecificOutput?.hookEventName !== "UserPromptSubmit") throw new Error("STATE_ROOM_HOOK_EVENT_NAME");
  } else if (JSON.stringify(output) !== "{}") throw new Error("STATE_ROOM_BELOW_THRESHOLD_EMPTY_HOOK");
  const context=output.hookSpecificOutput?.additionalContext ?? "No state warning";
  send({type:"stream_event",session_id:session,parent_tool_use_id:null,event:{type:"content_block_start",index:0,content_block:{type:"text",text:""}}});
  send({type:"stream_event",session_id:session,parent_tool_use_id:null,event:{type:"content_block_delta",index:0,delta:{type:"text_delta",text:context}}});
  send({type:"assistant",session_id:session,uuid:"odysseus-answer",parent_tool_use_id:null,message:{role:"assistant",content:[{type:"text",text:context}]}});
  send({type:"result",subtype:"success",session_id:session,uuid:"odysseus-result",is_error:false,duration_ms:1,duration_api_ms:1,num_turns:1,result:context,total_cost_usd:0,usage:{input_tokens:1,output_tokens:1,cache_creation_input_tokens:0,cache_read_input_tokens:0},modelUsage:{},permission_denials:[]});
  await new Promise(resolve=>setTimeout(resolve,10)); process.exit(0);
 }
}
`;
for (const percent of [50, 80]) test(`${percent}% copied state reaches the installed SDK's UserPromptSubmit callback and native context`, async () => {
  const root = mkdtempSync(join(tmpdir(), "claude-state-hook-"));
  const brain = join(root, "brain"), config = join(root, "config"), allowance = 100 * 4096;
  const project = `projects/${brain.replace(/[^a-zA-Z0-9]/g, "-")}`;
  mkdirSync(brain); mkdirSync(join(config, project), { recursive: true });
  writeFileSync(join(config, "settings.json"), "{}");
  writeFileSync(join(config, project, `${SESSION}.jsonl`), "x".repeat(percent * 4096 - 4096));
  const legacy = join(root, "brain-claude-state-odysseus"); mkdirSync(legacy);
  writeFileSync(join(legacy, "unknown-owner"), "Odysseus: retain unknown ownership.");
  const descriptors = ["mkdtempSync", "mkdirSync"].map(name => [name, Object.getOwnPropertyDescriptor(fs, name)!] as const);
  const created = spyOn(fs, "mkdtempSync"), directories = spyOn(fs, "mkdirSync");
  const frames: ServerMessage[] = [];
  let exited: Promise<number | null> | undefined;
  const queryFn = ((params: { prompt: Parameters<typeof query>[0]["prompt"]; options: Options }) => query({ ...params,
    options: { ...params.options, spawnClaudeCodeProcess: spawn => {
      const child = params.options.spawnClaudeCodeProcess!({ ...spawn,
      command: process.execPath, args: ["-e", runtime, SESSION, `--resume=${SESSION}`],
      env: { PATH: "/usr/bin:/bin", CLAUDE_CONFIG_DIR: config, HOME: root, PROJECT: project, EXPECTED_BYTES: String(percent * 4096 - 4096), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    });
      exited = new Promise(resolve => child.once("exit", (code: number | null) => resolve(code)));
      return child;
    } },
  })) as typeof query;
  try {
    const workerStartupView = createFixtureWorkerStartupView(brain);
    const backend = createClaudeBackend({ brainPath: brain, queryFn, workerState: { allowanceBytes: allowance, budgetBytes: allowance } });
    try { await backend.startTurn({ workerStartupView, sessionId: SESSION, prompt: "Return to Ithaca", signal: new AbortController().signal,
      bridge: { emit: frame => { frames.push(frame); }, requestPermission: async () => ({ behavior: "allow" }) } }); } finally { workerStartupView.cleanup(); }
    const terminal = frames.find(frame => frame.type === "result");
    expect(terminal?.isError, "REAL_SDK_HOOK_COMPLETED_NATIVE_RESULT").toBe(false);
    expect(terminal, "STATE_ROOM_RESULT_FROM_ACTUAL_COPY").toHaveProperty("stateRoom", { usedBytes: percent * 4096, allowanceBytes: allowance, observedAt: expect.any(Number) });
    expect(await exited, "STATE_ROOM_NATIVE_COPIED_BYTES_AND_EXIT").toBe(0);
    expect(created.mock.calls.some(([prefix]) => String(prefix).includes("brain-claude-state-")), "STATE_ROOM_NO_NEW_LEGACY_HOST_DIRECTORY").toBe(false);
    expect(directories.mock.calls.some(([path]) => String(path).includes("brain-claude-state-")), "STATE_ROOM_NO_NEW_LEGACY_HOST_DIRECTORY").toBe(false);
    expect(fs.readFileSync(join(legacy, "unknown-owner"), "utf8")).toBe("Odysseus: retain unknown ownership.");
    expect(processStateLedger().live, "normal starts release admission").toBe(0);
    const text = frames.filter(frame => frame.type === "text_delta").map(frame => frame.text).join("");
    if (percent === 80) expect(text, "REAL_SDK_HOOK_NATIVE_CONTEXT").toContain("0.313 MiB of 0.391 MiB (80%)");
    else expect(text).toBe("No state warning");
  } finally { created.mockRestore(); directories.mockRestore(); for (const [name, descriptor] of descriptors) Object.defineProperty(fs, name, descriptor); rmSync(root, { recursive: true, force: true }); }
});
