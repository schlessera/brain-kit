/**
 * Direct tests of the pi worker's RPC handler table (#2517): every handler
 * runs here without a worker, through the same dispatcher a session uses.
 * End-to-end refusals from a real worker stay in tests/pi-worker-runtime.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { NativeFileVersions } from "@schlessera/brain-ui-sdk/internal";
import { bashLockKey, compileConfirmPatterns, DEFAULT_CONFIRM_BASH_PATTERNS, type BackendBridge, type KeyedLock } from "@schlessera/brain-ui-sdk/server";

import type { SessionCaps } from "../src/backend-options";
import { DEFAULT_PI_ALLOWED_TOOLS } from "../src/tools";
import { createTurnContext } from "../src/turn-context";
import { createPiWorkerRpcDispatcher, PI_WORKER_RPC_HANDLERS, type PiWorkerRpc, type PiWorkerRpcContext } from "../src/worker-rpc";
import type { CallExecution } from "../src/worker-session";
import type { PiApplicationReceipt } from "../src/worker-receipts";
import { makeMockBridge } from "./mock-bridge";
import { staleAfterTicket } from "./stale-admission";
import { rememberPiAdmission } from "../src/tool-admission";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "pi-worker-rpc-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

let nextId = 0;
function rpc(method: string, toolName: string, input: Record<string, unknown>, toolCallId = "call-1"): PiWorkerRpc {
  return { type: "rpc", id: ++nextId, method: method as PiWorkerRpc["method"], toolName, toolCallId, input };
}

function harness(overrides: Partial<PiWorkerRpcContext> = {}, bridge: Partial<BackendBridge> = {}) {
  const turn = createTurnContext();
  const mock = makeMockBridge({});
  turn.bridge = { ...mock.bridge, ...bridge };
  turn.signal = new AbortController().signal;
  const executions = new Map<string, CallExecution>();
  const admitted: string[] = [];
  const observations: string[] = [];
  let persisted = 0;
  const applications = new Map<string, PiApplicationReceipt>();
  const nativeVersions = {
    beginRead: async (id: string, key: string) => { observations.push(`beginRead ${id} ${key}`); },
    finishRead: async (id: string) => { observations.push(`finishRead ${id}`); },
    check: () => undefined,
    beginWrite: async (key: string) => { observations.push(`beginWrite ${key}`); },
    finishWrite: async (key: string) => { observations.push(`finishWrite ${key}`); },
  } as unknown as NativeFileVersions;
  const context: PiWorkerRpcContext = {
    brainPath: root, turn, live: () => {}, grants: new Map(), releases: new Map(), workerLock: undefined,
    executed: msg => {
      let seen = executions.get(msg.toolCallId);
      if (!seen) executions.set(msg.toolCallId, seen = { name: msg.toolName, host: false, lock: false, phases: new Set() });
      return seen;
    },
    admitTool: name => { admitted.push(name); },
    autonomous: false, sandbox: { profile: "governed" }, workerSandbox: undefined,
    observeFile: () => undefined, nativeVersions, relayed: false, agentDir: root, agentFiles: {},
    allowedTools: new Set(DEFAULT_PI_ALLOWED_TOOLS), confirmPatterns: compileConfirmPatterns(DEFAULT_CONFIRM_BASH_PATTERNS, () => {}),
    bridgeTools: [], capabilities: {} as SessionCaps,
    receipts: { applications, persist: () => { persisted++; } },
    ...overrides,
  };
  return { context, dispatch: createPiWorkerRpcDispatcher(context), mock, executions, admitted, observations, applications, persisted: () => persisted };
}

test("the handler table has exactly one handler per protocol method", () => {
  expect(Object.keys(PI_WORKER_RPC_HANDLERS).sort())
    .toEqual(["admission", "apply", "bridge", "fileObservation", "lock", "permission", "readBase", "safetyResult", "safetyUnavailable", "syncAuth", "unlock"]);
});

test("a method without a handler is refused, including inherited object keys", async () => {
  const { dispatch } = harness();
  for (const method of ["bogus", "toString", "__proto__", "constructor"]) {
    await expect(dispatch(rpc(method, "read_file", {}))).rejects.toThrow("Unknown pi worker RPC method");
  }
});

test("every call proves the turn live and refuses a replayed id before its handler runs", async () => {
  const refused = harness({ live: () => { throw new Error("Pi worker RPC refused: turn is inactive, cancelled or revoked."); } });
  await expect(refused.dispatch(rpc("bogus", "read_file", {}))).rejects.toThrow("turn is inactive");
  const { dispatch, context } = harness();
  let released = 0;
  context.releases.set("lock-a", () => { released++; });
  const first = rpc("unlock", "bash", { lockId: "lock-a" });
  expect(await dispatch(first)).toEqual({ ok: true });
  await expect(dispatch({ ...first })).rejects.toThrow("Replayed pi worker RPC");
  expect(released).toBe(1);
});

test("unlock releases exactly a held lock and refuses any other", async () => {
  const { dispatch, context } = harness();
  let released = 0;
  context.releases.set("lock-a", () => { released++; });
  await expect(dispatch(rpc("unlock", "bash", { lockId: "lock-b" }))).rejects.toThrow("Unknown pi worker lock");
  await expect(dispatch(rpc("unlock", "bash", { lockId: "lock-a", extra: true }))).rejects.toThrow("Unknown pi worker lock");
  expect(await dispatch(rpc("unlock", "bash", { lockId: "lock-a" }))).toEqual({ ok: true });
  expect(released).toBe(1);
  expect(context.releases.size).toBe(0);
});

test("lock takes only the key the granted operation names", async () => {
  const acquired: string[] = [];
  const workerLock = { acquire: async (key: string) => { acquired.push(key); return () => {}; } } as unknown as KeyedLock;
  const { dispatch, context, executions } = harness({ workerLock });
  const command = "git commit -m odysseus";
  await expect(dispatch(rpc("lock", "bash", { key: bashLockKey(command) }))).rejects.toThrow("no server permission grant");
  context.grants.set("call-1", { name: "bash", input: JSON.stringify({ command }) });
  await expect(dispatch(rpc("lock", "bash", { key: "brain-docs-other" }))).rejects.toThrow("does not match the authorized operation");
  const answer = await dispatch(rpc("lock", "bash", { key: bashLockKey(command) })) as { lockId: string };
  expect(acquired).toEqual([bashLockKey(command)!]);
  expect(context.releases.has(answer.lockId)).toBe(true);
  expect(executions.get("call-1")?.lock).toBe(true);
});

test("fileObservation records a granted governed read phase and refuses outside its grant", async () => {
  const { dispatch, context, observations, executions } = harness({ observeFile: path => ({ key: `key:${path}`, version: {} as never }) });
  await expect(dispatch(rpc("fileObservation", "read_file", { phase: "read_start", path: "notes/ithaca.md" }))).rejects.toThrow("no matching granted operation");
  context.grants.set("call-1", { name: "read_file", input: JSON.stringify({ path: "notes/ithaca.md" }) });
  await expect(dispatch(rpc("fileObservation", "read_file", { phase: "write_check", path: "notes/ithaca.md" }))).rejects.toThrow("no matching granted operation");
  expect(await dispatch(rpc("fileObservation", "read_file", { phase: "read_start", path: "notes/ithaca.md" }))).toEqual({ ok: true });
  expect(observations).toEqual(["beginRead call-1 key:notes/ithaca.md"]);
  expect([...executions.get("call-1")!.phases]).toEqual(["read_start"]);
  const ungoverned = harness({ sandbox: { profile: "strict" } as PiWorkerRpcContext["sandbox"] });
  ungoverned.context.grants.set("call-1", { name: "read_file", input: JSON.stringify({ path: "notes/ithaca.md" }) });
  await expect(ungoverned.dispatch(rpc("fileObservation", "read_file", { phase: "read_start", path: "notes/ithaca.md" }))).rejects.toThrow("no matching granted operation");
});

test("syncAuth writes a native worker's login back and refuses a relayed worker", async () => {
  const relayed = harness({ relayed: true });
  await expect(relayed.dispatch(rpc("syncAuth", "", { content: "{}" }))).rejects.toThrow("cannot write the host's credential state");
  const { dispatch, context } = harness();
  await expect(dispatch(rpc("syncAuth", "", { content: 7 }))).rejects.toThrow("Malformed native pi state request");
  expect(await dispatch(rpc("syncAuth", "", { content: "{\"penelope\":true}" }))).toEqual({ ok: true });
  expect(readFileSync(join(root, "auth.json"), "utf8")).toBe("{\"penelope\":true}");
  expect(context.agentFiles["auth.json"]).toBe("{\"penelope\":true}");
});

test("permission allows an application tool with a server route without consulting the gate", async () => {
  const { dispatch, context, mock, admitted } = harness({}, { applyBrain: async () => ({ ok: true }) as never });
  expect(await dispatch(rpc("permission", "brain_add", { content: "Ithaca" }))).toEqual({ behavior: "allow" });
  expect(mock.permissionCalls).toHaveLength(0);
  expect(context.grants.size).toBe(0);
  expect(admitted).toEqual(["brain_add"]);
});

test("permission denies an application tool without a server route, and gates every other tool", async () => {
  const unrouted = harness();
  expect(await unrouted.dispatch(rpc("permission", "brain_add", { content: "Ithaca" })))
    .toEqual({ behavior: "deny", message: "No server application route is available in this turn." });
  const { dispatch, context } = harness();
  const decision = await dispatch(rpc("permission", "read_file", { path: "notes/ithaca.md" })) as { behavior: string };
  expect(decision.behavior).toBe("allow");
  expect(context.grants.get("call-1")).toEqual({ name: "read_file", input: JSON.stringify({ path: "notes/ithaca.md" }) });
  // A governed host sandbox keeps native write_file: it is gated, not routed.
  const governed = harness({ workerSandbox: { brain: root, restricted: false, profile: "governed", areas: [], scratchAliasesRemoved: [] } }, { applyBrain: async () => ({ ok: true }) as never });
  await governed.dispatch(rpc("permission", "write_file", { path: "notes/ithaca.md", content: "home" }));
  expect(governed.context.grants.get("call-1")?.name).toBe("write_file");
});

test("bridge runs a granted roster tool on the host once", async () => {
  const probe = { name: "probe", execute: async () => ({ content: [{ type: "text" as const, text: "Telemachus" }], details: null }) };
  const { dispatch, context, executions } = harness({ bridgeTools: [probe] as unknown as PiWorkerRpcContext["bridgeTools"] });
  await expect(dispatch(rpc("bridge", "probe", {}))).rejects.toThrow("no matching server permission decision");
  context.grants.set("call-1", { name: "probe", input: "{}" });
  expect(await dispatch(rpc("bridge", "probe", {}))).toEqual({ content: [{ type: "text", text: "Telemachus" }], details: null });
  expect(executions.get("call-1")?.host).toBe(true);
  expect(context.grants.size).toBe(0);
  context.grants.set("call-2", { name: "absent", input: "{}" });
  await expect(dispatch(rpc("bridge", "absent", {}, "call-2"))).rejects.toThrow("outside the turn's capability roster");
});

test("readBase reads the granted path's server base and refuses any other", async () => {
  const base = { content: "Ithaca.\n", expectedBaseHash: "a".repeat(64) };
  const { dispatch, context, executions } = harness({}, { readBrainBase: async () => base as never });
  await expect(dispatch(rpc("readBase", "brain_read", { path: "notes/ithaca.md" }))).rejects.toThrow("Malformed pi document-base request");
  context.grants.set("call-1", { name: "brain_read_base", input: JSON.stringify({ path: "notes/troy.md" }) });
  await expect(dispatch(rpc("readBase", "brain_read_base", { path: "notes/ithaca.md" }))).rejects.toThrow("no matching server permission decision");
  context.grants.set("call-2", { name: "brain_read_base", input: JSON.stringify({ path: "notes/ithaca.md", offset: 1 }) });
  expect(await dispatch(rpc("readBase", "brain_read_base", { path: "notes/ithaca.md" }, "call-2"))).toEqual(base);
  expect(executions.get("call-2")?.host).toBe(true);
});

test("apply sends one application to the server route and keeps its receipt", async () => {
  const inputs: unknown[] = [];
  const { dispatch, context, applications, persisted } = harness({}, { applyBrain: async input => { inputs.push(input); return { ok: true, path: "notes/ithaca.md" } as never; } });
  context.turn.pendingMutations = new Set();
  expect(await dispatch(rpc("apply", "brain_add", { operation: "add", content: "Ithaca" }))).toEqual({ ok: true, path: "notes/ithaca.md" });
  expect(inputs).toEqual([{ operation: "add", content: "Ithaca" }]);
  expect(applications.get("call-1")).toEqual({ name: "brain_add", input: { operation: "add", content: "Ithaca" }, result: { ok: true, path: "notes/ithaca.md" } as never });
  expect(persisted()).toBe(1);
  expect(context.turn.pendingMutations.size).toBe(0);
  const unrouted = harness();
  await expect(unrouted.dispatch(rpc("apply", "brain_add", { operation: "add", content: "Ithaca" }))).rejects.toThrow("No authoritative server application route");
});


test("the result RPC awaits host evidence before release and cannot self-assert finalization",async()=>{
 let release!:()=>void;const committed=new Promise<void>(resolve=>{release=resolve});const seen:unknown[]=[];
 const {dispatch}=harness({}, {inputSafety:{ready:async()=>{},begin:async()=>{},result:async(...args)=>{seen.push(args);await committed;}}});
 let returned=false;const result=dispatch(rpc("safetyResult","read_file",{output:"Ithaca"})).then(()=>{returned=true});
 await Promise.resolve();expect(returned,"PI_SAFETY_RESULT_WAITS_FOR_COMMIT").toBe(false);
 expect(seen).toEqual([["call-1","read_file","Ithaca",false]]);release();await result;
});

test("an unavailable collector notice awaits durable failure and carries no tool or caller details",async()=>{
 let release!:()=>void,called=0;const committed=new Promise<void>(resolve=>{release=resolve});
 const {dispatch}=harness({}, {inputSafety:{ready:async()=>{},begin:async()=>{},result:async()=>{},unavailable:async()=>{called++;await committed;}}});
 await expect(dispatch(rpc("safetyUnavailable","grep",{},""))).rejects.toThrow("Malformed safety unavailable");
 await expect(dispatch(rpc("safetyUnavailable","",{reason:"safe"},""))).rejects.toThrow("Malformed safety unavailable");
 expect(called).toBe(0);
 let returned=false;const result=dispatch(rpc("safetyUnavailable","",{},"")).catch(error=>{returned=true;return error;});
 await Promise.resolve();expect(returned,"PI_SAFETY_UNAVAILABLE_WAITS_FOR_COMMIT").toBe(false);
 expect(called).toBe(1);release();expect(String(await result)).toContain("Unqualified Pi input transformations");
});

test("every permission answer but allow refuses the call at the collector, and an allow is checked first", async () => {
  // Pi runs a call only on "allow". A denial or a rejection refuses the
  // call's id, so nothing later under it is admitted or let run. Only a deny
  // answer is the host's own denial, which can prove the call never ran; a
  // rejection proves nothing. Every request is one admission (#3812).
  const refused: [string, boolean | undefined][] = [], allowed: string[] = [], admitted: string[] = [];
  const inputSafety = { ready: async () => {}, begin: async () => {}, result: async () => {}, admitting: (id: string, tool?: string) => { admitted.push(`${tool}:${id}`); },
    refused: async (id: string, denied?: boolean) => { refused.push([id, denied]); }, allowed: async (id: string) => { allowed.push(id); } };
  const routed = harness({}, { applyBrain: async () => ({ ok: true }) as never, inputSafety });
  expect(await routed.dispatch(rpc("permission", "brain_add", { content: "Ithaca" }, "call-allowed"))).toEqual({ behavior: "allow" });
  const unrouted = harness({}, { inputSafety });
  expect(await unrouted.dispatch(rpc("permission", "brain_add", { content: "Ithaca" }, "call-denied"))).toMatchObject({ behavior: "deny" });
  // Stopped after admission, before its answer: the worker blocks the call.
  let checks = 0;
  const stopped = harness({ live: () => { if (++checks > 1) throw new Error("Pi worker RPC refused: turn is inactive, cancelled or revoked."); } },
    { applyBrain: async () => ({ ok: true }) as never, inputSafety });
  await expect(stopped.dispatch(rpc("permission", "brain_add", { content: "Ithaca" }, "call-stopped"))).rejects.toThrow("turn is inactive");
  expect(refused, "PI_NON_ALLOW_PERMISSION_REFUSES_THE_CALL").toEqual([["call-denied", true], ["call-stopped", undefined]]);
  expect(allowed, "PI_ALLOWED_PERMISSION_IS_CHECKED_BEFORE_IT_RUNS").toEqual(["call-allowed"]);
  // A later request in the stopped turn is an admission too, and only rejected.
  await expect(stopped.dispatch(rpc("permission", "brain_add", { content: "Ithaca" }, "call-stopped"))).rejects.toThrow();
  expect(admitted, "PI_EVERY_PERMISSION_REQUEST_IS_AN_ADMISSION").toEqual(["brain_add:call-allowed", "brain_add:call-denied", "brain_add:call-stopped", "brain_add:call-stopped"]);
  expect(refused.at(-1), "PI_REJECTED_REQUEST_IS_NO_DENIAL").toEqual(["call-stopped", undefined]);
});

test("an allow the collector's last check refuses is denied, and its grant never published", async () => {
  // The call's id was refused, or its latest admission did not complete: it
  // must not run, and nothing it could use may exist (#3812).
  const refused: [string, boolean | undefined][] = [];
  const inputSafety = { ready: async () => {}, begin: async () => {}, result: async () => {}, refused: async (id: string, denied?: boolean) => { refused.push([id, denied]); },
    allowed: async () => { throw new Error("Safety operation was refused or not admitted; the call does not run"); } };
  const { context, dispatch } = harness({}, { inputSafety });
  const answer = await dispatch(rpc("permission", "read_file", { path: "notes/ithaca.md" }, "call-refused"));
  expect(answer, "PI_UNCHECKED_ALLOW_IS_DENIED").toMatchObject({ behavior: "deny", message: expect.stringContaining("does not run") });
  expect(context.grants.has("call-refused"), "PI_UNCHECKED_ALLOW_LEAVES_NO_GRANT").toBe(false);
  expect(refused, "PI_UNCHECKED_ALLOW_IS_REFUSED").toEqual([["call-refused", true]]);
});

test("a permission whose safety goes stale during the wait after its dispatch ticket is denied and leaves no grant", async () => {
  // The final admission validates again after the last pending wait (#4767).
  const { admissionSafety, inputSafety, log } = staleAfterTicket();
  const { context, dispatch } = harness({}, { admissionSafety, inputSafety });
  const answer = await dispatch(rpc("permission", "read_file", { path: "notes/ithaca.md" }, "call-stale"));
  expect(answer, "PI_PERMIT_STALE_AFTER_WAIT_IS_DENIED").toMatchObject({ behavior: "deny", message: expect.stringContaining("Safety or authority changed") });
  expect(context.grants.has("call-stale"), "PI_PERMIT_STALE_AFTER_WAIT_LEAVES_NO_GRANT").toBe(false);
  expect(log, "PI_PERMIT_STALE_AFTER_WAIT_IS_REFUSED").toEqual(["prepare call-stale", "stale", "cancel", "refused call-stale true"]);
});

test("a final bash admission whose safety goes stale during the wait after its dispatch ticket is refused", async () => {
  const { admissionSafety, inputSafety, log } = staleAfterTicket();
  const { context, dispatch } = harness({}, { admissionSafety, inputSafety });
  const input = { command: "ls notes" };
  context.grants.set("call-stale", { name: "bash", input: JSON.stringify(input) });
  rememberPiAdmission(context.turn, "bash", "call-stale", input, admissionSafety.read(), false, admissionSafety);
  await expect(dispatch(rpc("admission", "bash", input, "call-stale")), "PI_ADMISSION_STALE_AFTER_WAIT_REJECTS").rejects.toThrow("Safety or authority changed");
  expect(log, "PI_ADMISSION_STALE_AFTER_WAIT_IS_REFUSED").toEqual(["prepare call-stale", "stale", "cancel", "refused call-stale true"]);
});

test.each([true,false])("post-failure remedies use the resolved Pi sandbox (host supplied=%s)", async supplied => {
  const sandbox={brain:root,profile:"governed" as const,restricted:false,scratchAliasesRemoved:[],areas:[{name:"workspaces" as const,rel:"workspaces",mount:{writable:false as const,readOnlyPath:join(root,"workspaces"),reason:"inspection"}}]};
  const recorded:string[]=[];
  const {dispatch}=harness({sandbox,workerSandbox:supplied?sandbox:undefined},{inputSafety:{ready:async()=>{},begin:async()=>{},allowed:async()=>{},result:async(_id:string,_name:string,output:string)=>{recorded.push(output);}} as never});
  for(const command of ["npm install --dry-run","bun test","npm help install","npm ls build","npm install","npm i","npm ci","npm clean-install","mkdir workspaces/ithaca/build","mkdir -p workspaces/ithaca/build","git add raft.md","pnpm add ithaca","yarn run build","bun run build"]){
    const id=command;
    expect(await dispatch(rpc("permission","bash",{command:`cd workspaces/ithaca && ${command}`},id)),"PI_VERIFICATION_RUNS_BEFORE_ANY_REFUSAL").toMatchObject({behavior:"allow"});
    const answer=await dispatch(rpc("safetyResult","bash",{output:`EROFS: Read-only file system, open '${root}/workspaces/ithaca/package-lock.json'`,failed:true},id));
    expect(answer,"SELF_RESOLVED_SANDBOX_HAS_BOTH_REMEDIES").toMatchObject({workspaceNote:expect.stringContaining("managed worktree")});
    expect(await dispatch(rpc("safetyResult","bash",{output:"mkdir: cannot create directory '/outside/raft': Read-only file system",failed:true},id)),"PI_OUTSIDE_READ_ONLY_FAILURE_HAS_CONDITIONAL_ADVICE").toMatchObject({workspaceNote:"If this write was under workspaces/, the checkout is read-only in this turn: switch on code changes for this session (applies from the next message) or use a managed worktree."});
    expect(recorded.at(-1),"NOTE_RECORDED_BEFORE_DELIVERY").toContain("switch on code changes for this session");
    expect(await dispatch(rpc("safetyResult","bash",{output:`open '${root}/workspaces/ithaca/README.md'\n/bin/bash: /tmp/readonly/raft.md: Permission denied`,failed:true},id)),"PLAIN_PERMISSION_FAILURE_IS_NOT_A_READ_ONLY_DIAGNOSTIC").toEqual({ok:true});
    expect(await dispatch(rpc("safetyResult","bash",{output:"all tests passed"},id)),"SUCCESSFUL_VERIFICATION_HAS_NO_REFUSAL").toEqual({ok:true});
    expect(await dispatch(rpc("safetyResult","bash",{output:"assertion failed",failed:true},id)),"NORMAL_TEST_FAILURE_HAS_NO_REFUSAL").toEqual({ok:true});
  }
});


test.each([
 ["mkdir", "mkdir: cannot create directory 'workspaces/ithaca/build': Read-only file system"],
 ["mkdir -p", "mkdir: cannot create directory 'workspaces/ithaca/build': Read-only file system"],
 ["git add", "fatal: Unable to create 'workspaces/ithaca/.git/index.lock': Read-only file system"],
 ["npm install", "npm error code EROFS"],
 ["outside write", "touch: cannot touch '/outside/raft': Read-only file system"],
])("Pi's installed Agent hook appends and records the post-failure remedy once: %s",async(_command,diagnostic)=>{
 const {Agent}=await import("@earendil-works/pi-agent-core"),{installPiToolSafety}=await import("../src/tool-safety.js"),{safetyResultInput}=await import("../src/worker-protocol.js");
 const sandbox={brain:root,profile:"strict" as const,restricted:false,scratchAliasesRemoved:[],areas:[{name:"workspaces" as const,rel:"workspaces",mount:{writable:false as const,readOnlyPath:join(root,"workspaces"),reason:"inspection"}}]};
 const recorded:string[]=[];const {dispatch}=harness({sandbox},{inputSafety:{begin:async()=>{},allowed:async()=>{},result:async(_id:string,_name:string,output:string)=>{recorded.push(output);}} as never});
 const agent=new Agent({streamFn:()=>{throw new Error("No inference in this hook test");}});
 installPiToolSafety(agent,{permission:(name,id,input)=>dispatch(rpc("permission",name,input,id)) as never,result:async(name,id,content,complete,failed)=>{const answer=await dispatch(rpc("safetyResult",name,safetyResultInput(name,content,complete,failed),id)) as {workspaceNote?:string};return answer.workspaceNote;},stop(){}},()=>false);
 const {createBrainToolKit}=await import("../src/tool-kit.js"),{createBrainAccess}=await import("../src/brain-access.js"),{bashTool}=await import("../src/file-tools.js"),{toolLockFromKeyed}=await import("../src/tools.js"),{createKeyedLock}=await import("@schlessera/brain-ui-sdk/server");
 mkdirSync(join(root,"workspaces/ithaca"),{recursive:true});
 const kit=createBrainToolKit({brain:createBrainAccess(root),turn:createTurnContext(),lock:toolLockFromKeyed(createKeyedLock()),exec:{}});
 const args={command:`printf %s ${"'"+diagnostic.replaceAll("'", "'\"'\"'")+"'"} >&2; exit 1`};
 const result=await bashTool(kit).execute("verify",args,undefined,undefined,{} as never);
 expect((result.details as {exitCode: number}).exitCode,"REAL_BASH_USES_EXIT_CODE_DETAILS").toBe(1);
 const context={toolCall:{id:"verify",name:"bash"},args,result,isError:false} as never;
 expect(await agent.beforeToolCall!(context),"INSTALLED_AGENT_ADMITS_VERIFICATION").toBeUndefined();
 const answer=await agent.afterToolCall!(context);
 expect(answer!.content,"INSTALLED_AGENT_DELIVERS_REMEDY_AFTER_BASH_EXIT_FAILURE").toEqual([...result.content,{type:"text",text:expect.stringContaining("switch on code changes for this session")}]);
 expect(recorded).toHaveLength(1);expect(recorded[0]).toContain("managed worktree");
});
