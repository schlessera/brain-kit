/** Private actual SDK/native skill measurement. Importing this file dispatches nothing. */
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { CLEARED_API_CREDENTIALS, NEUTRALISED_SETTINGS, subscriptionVerdict, settingsRefusal } from "../../../packages/ui-backend-claude/src/subscription";
import { actualNativeRuntime } from "./native-runtime";
import { priceSonnet55Usage } from "../../measure-sonnet55-cost";
import { type NativeEvidence, type Phase } from "./collector";
import { captureNative, drainOwned } from "./native-capture";
import { MODEL, startRelay, physicalPriceDiagnostics, type NativeCall } from "./native-relay";
import { assertReviewAdmission, assertScoredAdmission, type ReviewArtifacts } from "./admission";
import type { TreeEvidence } from "./observer";
import { toolVerdict, type ToolObservation } from "./native-tools";
import { actualWriteDayUTC, assertWriteDayUTC, assertNativeWriteWindowUTC, previousWriteDayUTC } from "./write-day";
export const runtime = { sdk: "0.3.292", cli: "2.1.292", model: MODEL };
export interface NativeOptions {
  root: string; source: string; destination: string; phase: Phase; token: string;
  offline: boolean;
  writeDayUTC?: string;
  offlineWriteDayMismatchAfterDispatch?: true;
  physicalFetch?: (url: string, init: RequestInit) => Promise<Response>;
  deadlineMs?: number;
  offlineDeadlineAfterDispatchMs?:number;
  prompt?: string;
  purpose?: "offline-skill" | "complementary-review" | "scored-skill";
  reviewArtifacts?: ReviewArtifacts;
  caseId?: string;
  initialDocuments?: number;
  inputEvidence?:TreeEvidence;
  reviewBinding?: { freezeSha:string; proofSha:string; planSha:string; writeDayUTC:string };
}
export interface ActualNativeReceipt {
  writeDayUTC: string | null; physicalWriteDayUTC: string; writeDayRefused: boolean;
  runtimePair: ReturnType<typeof actualNativeRuntime>;
  executionKind: "offline-scripted-control" | "live-subscription";
  admissionEvidence: unknown;
  native: NativeEvidence; init: any; accountRoute: unknown; settingsChecked: boolean;
  promptReleased: boolean; rateLimits: any[]; result: any; apiEquivalent: unknown;
  physicalCalls: NativeCall[]; diagnostics:ReturnType<typeof physicalPriceDiagnostics>; tools: ToolObservation[]; durationMs: number;
  childClose: {code:number|null;signal:string|null}|null;
  forcedKill: boolean; stdoutComplete: boolean; stderrComplete: boolean;
}
export async function* protectedPrompt(handle: Promise<any>, payload: string,
  receipt: ActualNativeReceipt, save: () => void, controller: AbortController) {
  const cli = await handle, init = await cli.initializationResult();
  const verdict = subscriptionVerdict(init.account), settings = await cli.getSettings();
  const refusal = settingsRefusal(settings);
  receipt.accountRoute = { accepted: verdict.ok, tokenSource: init.account?.tokenSource,
    apiKeySource: init.account?.apiKeySource ?? "none", apiProvider: init.account?.apiProvider };
  receipt.settingsChecked = !refusal; save();
  if (!verdict.ok || refusal) { controller.abort(); throw Error("Protected subscription/settings handshake refused"); }
  receipt.promptReleased = true; save();
  yield { type: "user" as const, session_id: "", parent_tool_use_id: null, message: { role: "user" as const, content: payload } };
}
/** Complete terminal physical counters must agree with canonical final native usage. */
export function reconcilePhysicalUsage(result: any, calls: NativeCall[]) {
      const models = Object.entries(result?.modelUsage ?? {});
      if (models.length !== 1 || models[0]?.[0] !== MODEL) throw Error("Unexpected final auxiliary model usage");
      const usage = models[0][1] as any;
      for (const [field, rawField] of [["inputTokens","input_tokens"],["outputTokens","output_tokens"],["cacheReadInputTokens","cache_read_input_tokens"],["cacheCreationInputTokens","cache_creation_input_tokens"]]) {
        const sum = calls.reduce((n, call) => n + (call.usage?.[rawField] ?? NaN), 0);
        if (!Number.isSafeInteger(sum) || sum !== usage[field]) throw Error(`Physical usage differs from final native modelUsage: ${field}`);
      }
 }
/** Native clocks stay real. Only brain's executable shim preloads the fixture clock. */
export async function runNativePhase(options: NativeOptions): Promise<ActualNativeReceipt> {
  let admissionEvidence:unknown=null;
  if(options.offlineWriteDayMismatchAfterDispatch && !options.offline) throw Error("Write-day mismatch probe is explicitly offline only");
  if(options.offlineDeadlineAfterDispatchMs!==undefined&&(!options.offline||options.offlineDeadlineAfterDispatchMs!==200))throw Error("Only the fixed explicitly offline active-deadline control is permitted");
  if(options.offline){
    if(process.env.BRAIN_HYGIENE_OFFLINE!=="1")throw Error("Explicit offline native proof required");
    const interfaces=readFileSync("/proc/net/dev","utf8").split("\n").slice(2).map(line=>line.split(":")[0]?.trim()).filter(Boolean);
    if(interfaces.some(name=>name!=="lo"))throw Error("Offline proof requires an actual isolated loopback-only network namespace");
    if(options.token!==`sk-ant-oat01-${"o".repeat(95)}AA`)throw Error("Offline proof requires the fixed noncredential token");
  }else{
    if(options.purpose==="complementary-review"&&options.reviewBinding){
      admissionEvidence=assertReviewAdmission(options.reviewBinding.freezeSha,options.reviewBinding.proofSha,options.reviewBinding.planSha,options.reviewBinding.writeDayUTC);
    }else if(options.purpose==="scored-skill"&&options.reviewArtifacts){
      admissionEvidence=await assertScoredAdmission(options.reviewArtifacts);
      const {assertNativeInput}=await import("./native-input");
      if(!options.inputEvidence)throw Error("Complete pre-dispatch phase input snapshot required");
      assertNativeInput(options.root,options.caseId??"",options.initialDocuments??0,options.phase,options.inputEvidence);
    }else throw Error("Complete exact-frozen semantic input approval and native admission required");
  }
  const reviewing=options.purpose==="complementary-review";
  let writeDayUTC = reviewing ? options.reviewBinding?.writeDayUTC ?? null : options.writeDayUTC ?? actualWriteDayUTC();
  if(!options.offline&&!reviewing && options.writeDayUTC === undefined)throw Error("Exact reviewed physical write-day binding required");
  if(!options.offline&&!reviewing && (admissionEvidence as any)?.writeDayUTC!==writeDayUTC)throw Error("Native write day differs from complete review approval");
  if(writeDayUTC !== null) assertNativeWriteWindowUTC(writeDayUTC,options.deadlineMs??300000);
  const root = realpathSync(options.root), source = realpathSync(options.source);
  const actualPair=actualNativeRuntime(source,options.offline);
  mkdirSync(options.destination, { mode: 0o700 });
  const home = join(options.destination, "native-home"); mkdirSync(home, { mode: 0o700 });
  const raw = join(options.destination, "native-stdout.jsonl"); writeFileSync(raw, "", { mode: 0o600 });
  const rawError = join(options.destination,"native-stderr.txt"); writeFileSync(rawError,"",{mode:0o600});
  const receipt: ActualNativeReceipt = { writeDayUTC, physicalWriteDayUTC:actualWriteDayUTC(), writeDayRefused:false, runtimePair:actualPair, executionKind: options.offline?"offline-scripted-control":"live-subscription", admissionEvidence, native: { model: MODEL, exitCode: -1,
    naturalStdoutEof: false, ownedChildDrained: false, overage: "unknown", calls: [], failure: null },
    init: null, accountRoute: null, settingsChecked: false, promptReleased: false,
    rateLimits: [], result: null, apiEquivalent: null, physicalCalls: [], diagnostics:physicalPriceDiagnostics([]), tools: [], durationMs: 0,
    childClose:null, forcedKill: false, stdoutComplete: false, stderrComplete: false };
  const save = () => writeFileSync(join(options.destination, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  const controller = new AbortController(), started = performance.now();
  if(options.offline&&!options.physicalFetch)throw Error("Scripted offline physical transport required");
  let armActiveDeadline:(()=>void)|undefined;
  const physicalFetch=options.offline?async(url:string,init:RequestInit)=>{if(writeDayUTC !== null)assertWriteDayUTC(writeDayUTC);armActiveDeadline?.();if(options.offlineWriteDayMismatchAfterDispatch)writeDayUTC=previousWriteDayUTC();return options.physicalFetch!(url,init);}:(url:string,init:RequestInit)=>{
    if(writeDayUTC !== null)assertWriteDayUTC(writeDayUTC);
    if(new URL(url).origin!=="https://api.anthropic.com")throw Error("Unexpected first-party inference origin");
    return fetch(url,{...init,redirect:"error"});
  };
  const relay = startRelay({ oauthToken: options.token, fetch: physicalFetch,
    save: calls => { receipt.physicalCalls = calls; receipt.diagnostics=physicalPriceDiagnostics(calls); save(); } });
  let child: ChildProcess | undefined, childClosed: Promise<void> | undefined, cli: any;
  let resolveHandle!: (value: any) => void;
  const handle = new Promise(resolve => resolveHandle = resolve);
  const abortDeadline=()=>{receipt.native.failure="Native deadline exceeded";save();controller.abort();};
  let deadline=setTimeout(abortDeadline,options.deadlineMs??300000);
  if(options.offlineDeadlineAfterDispatchMs!==undefined)armActiveDeadline=()=>{armActiveDeadline=undefined;clearTimeout(deadline);deadline=setTimeout(abortDeadline,options.offlineDeadlineAfterDispatchMs);};
  const binary = actualPair.native;
  const env = { PATH: `${join(root, "bin")}:/usr/bin:/bin:${join(process.execPath, "..")}`,
    ...CLEARED_API_CREDENTIALS, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"),
    TMPDIR: "/tmp", CLAUDE_CODE_OAUTH_TOKEN: options.token, ANTHROPIC_BASE_URL: relay.url,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL, ANTHROPIC_SMALL_FAST_MODEL: MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL, CLAUDE_CODE_SUBAGENT_MODEL: MODEL,
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1", TZ: process.env.TZ ?? "UTC" };
  try {
    cli = query({ prompt: protectedPrompt(handle, options.prompt ??
      `Run the installed /content-hygiene skill${options.phase === "dry-run" ? " --dry-run" : ""}. The brain CLI tool clock and fictional document reference day are 2026-07-12. Use the shipped phases, stop on command failure and report. Read the actual source before editing. Native process clocks stay real.`, receipt, save, controller), options: {
      cwd: root, settingSources: [], settings: { ...NEUTRALISED_SETTINGS, autoMemoryEnabled: false },
      persistSession: false, model: MODEL, env, abortController:controller, maxTurns: reviewing?1:24, effort: "low",
      ...(reviewing?{maxBudgetUsd:3}:{}),
      permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
      tools: reviewing?[]:["Read", "Edit", "Write", "Bash", "Glob", "Grep", "Skill", "TodoWrite"],
      hooks: { PreToolUse: [{ matcher: ".*", hooks: [async input => {
        const event = input as any; let allowed = !reviewing && toolVerdict(root, options.phase, event.tool_name, event.tool_input ?? {});
        if (allowed && writeDayUTC !== null) {
          try { assertNativeWriteWindowUTC(writeDayUTC,options.deadlineMs??300000); }
          catch (error) { allowed=false; receipt.writeDayRefused=true; receipt.native.failure=String(error); controller.abort(); }
        }
        receipt.tools.push({ name: event.tool_name, input: event.tool_input, allowed, reason: allowed ? "Contained current-skill surface" : "Outside the frozen hygiene tool surface" }); save();
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: allowed ? "allow" : "deny", permissionDecisionReason: allowed ? "Contained hygiene fixture" : "Measurement boundary denies this tool request" } };
      }] }] },
      spawnClaudeCodeProcess: spawned => {
        if (realpathSync(spawned.command) !== realpathSync(binary)) throw Error("SDK native binary differs from installed frozen runtime");
        if (Object.keys(CLEARED_API_CREDENTIALS).some(key => spawned.env[key])) throw Error("API/routing credential reintroduced before native spawn");
        const args = ["--die-with-parent", "--new-session", "--unshare-all", "--share-net"];
        for (const path of ["/usr", "/bin", "/lib", "/lib64"]) args.push("--ro-bind", path, path);
        args.push("--ro-bind", "/etc/ssl", "/etc/ssl", "--ro-bind", "/etc/hosts", "/etc/hosts", "--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf",
          "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
          "--ro-bind", source, source, "--ro-bind", process.execPath, process.execPath,
          "--bind", root, root, "--bind", home, home, "--chdir", root, "--", spawned.command, ...spawned.args);
        child = spawn("bwrap", args, { env: spawned.env, stdio: ["pipe", "pipe", "pipe"] });
        const capture = captureNative(raw, line => {
          const frame = JSON.parse(line);
          if (frame.type === "system" && frame.subtype === "init") {
            receipt.init = { model: frame.model, apiKeySource: frame.apiKeySource, cli: frame.claude_code_version };
            if (frame.model !== MODEL || frame.apiKeySource !== "none" || frame.claude_code_version !== actualPair.cli) {
              receipt.native.failure = "Native model/auth/runtime mismatch"; controller.abort();
            }
          }
          if (frame.type === "rate_limit_event") {
            const info = frame.rate_limit_info ?? {}; receipt.rateLimits.push(info);
            if (info.isUsingOverage === true || info.overageInUse === true) { receipt.native.overage = "active"; receipt.native.failure = "Subscription overage reported"; controller.abort(); }
          }
          if (frame.type === "result") { receipt.result = frame; if (frame.is_error || frame.subtype !== "success") { receipt.native.failure = "Native result failed"; controller.abort(); } }
          save();
        }, () => { receipt.stdoutComplete = true; save(); });
        capture.on("error", error => { receipt.native.failure ??= String(error); save(); controller.abort(); });
        child.stdout!.pipe(capture); Object.defineProperty(child, "stdout", { value: capture });
        child.stderr!.on("data", bytes => appendFileSync(rawError, bytes)); child.stderr!.on("end", () => { receipt.stderrComplete = true; save(); });
        childClosed = new Promise(resolve => child!.once("close", (code,signal) => { receipt.native.exitCode = code ?? -1; receipt.childClose={code,signal}; resolve(); }));
        return child as any;
      },
    } });
    resolveHandle(cli);
    for await (const frame of cli) if (frame.type === "result") receipt.result = frame;
  } catch (error) { receipt.native.failure ??= String(error); }
  finally {
    if(writeDayUTC !== null)try { assertWriteDayUTC(writeDayUTC); } catch(error) { receipt.writeDayRefused=true; receipt.native.failure ??= String(error); controller.abort(); }
    clearTimeout(deadline); try { cli?.close(); } catch (error) { receipt.native.failure ??= String(error); }
    if (child && childClosed) { const drain = await drainOwned(child, childClosed); receipt.forcedKill = drain.forcedKill;
      receipt.native.ownedChildDrained = true; if (drain.forcedKill) receipt.native.failure ??= "Owned child required forced kill"; }
    receipt.native.naturalStdoutEof = receipt.stdoutComplete && !receipt.forcedKill;
    receipt.native.overage = receipt.rateLimits.some(r => r.isUsingOverage === true || r.overageInUse === true) ? "active" : receipt.rateLimits.length && receipt.rateLimits.every(r => r.isUsingOverage === false || r.overageInUse === false) ? "reported inactive" : "unknown";
    receipt.native.calls = relay.calls.map(call => ({ requestedModel: call.requestedModel,
      servedModel: call.servedModel ?? "unknown", route: "native-claude-subscription", subscriptionAuthenticated: receipt.promptReleased,
      status: call.status ?? -1, inputTokens: call.usage?.input_tokens ?? NaN,
      outputTokens: call.usage?.output_tokens ?? NaN, cacheReadTokens: call.usage?.cache_read_input_tokens ?? null,
      cacheWriteTokens: call.usage?.cache_creation_input_tokens ?? null,
      completed: call.finished && call.outcome === "completed", rawUsage: call.usage }));
    try {
      const equivalent = priceSonnet55Usage(receipt.result);
      reconcilePhysicalUsage(receipt.result, relay.calls);
      receipt.apiEquivalent = equivalent;
    } catch (error) { receipt.apiEquivalent = null; receipt.native.failure ??= String(error); }
    if (!receipt.init || !receipt.result || !relay.complete() || !receipt.stderrComplete) receipt.native.failure ??= "Missing complete native/physical/stream evidence";
    await relay.stop(); receipt.physicalWriteDayUTC=actualWriteDayUTC(); if(writeDayUTC !== null)try { assertWriteDayUTC(writeDayUTC); } catch(error) { receipt.writeDayRefused=true; receipt.native.failure ??= String(error); } receipt.durationMs = performance.now() - started; save();
  }
  return receipt;
}
