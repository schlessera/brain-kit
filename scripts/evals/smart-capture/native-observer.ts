/** Actual core Claude runner transport tee; authentication remains in cli-runners. */
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { appendFileSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { overageAllowed, assertPaidPolicy } from "./paid-policy";
import { priceSonnet55Usage } from "../../measure-sonnet55-cost";

export const MODEL = "claude-sonnet-5-5";
async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), milliseconds); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
async function main() {
  if (process.env.BRAIN_LIVE_EVAL !== "839" && process.env.BRAIN_SMART_OFFLINE !== "1") throw Error("Explicit #839 dispatch required");
  const destination = process.env.BRAIN_SMART_RECEIPT;
  const source = process.env.BRAIN_SMART_SOURCE;
  if (!destination || !source || !process.env.BRAIN_ROOT) throw Error("Missing isolated observer paths");
  const command = JSON.parse(process.env.BRAIN_SMART_NATIVE_COMMAND ?? "null") as string[];
  if (!Array.isArray(command) || !command.length || command.some(v => typeof v !== "string")) throw Error("Require exact native argv prefix");
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) throw Error("Subscription token required; API credentials refused");
  const args = process.argv.slice(2);
  const index = args.indexOf("--settings");
  if (index < 0 || !args[index + 1]) throw Error("Actual core neutralised settings are absent");
  const settings = JSON.parse(args[index + 1]!);
  settings.autoMemoryEnabled = false;
  settings.hooks = { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: `python3 ${JSON.stringify(join(source, "scripts/evals/smart-capture/tool-hook.py"))}` }] }] };
  args[index + 1] = JSON.stringify(settings);
  const readOnlyReview = process.env.BRAIN_SMART_READONLY_REVIEW === "1";
  args.push("--model", MODEL, "--no-session-persistence", "--max-turns", readOnlyReview ? "1" : "12");
  if (readOnlyReview) args.push("--tools", "", "--effort", "low");
  const receipt: any = { model: MODEL, promptReleased: false, result: null, init: null,
    rates: [], account: null, settings: null, apiEquivalent: null, failure: null,
    additionalBilledUsd: null, startedAtUtc: new Date(Date.now()).toISOString(), finishedAtUtc: null, overage: "unknown", startedAt: performance.now(), finished: false,
    nativePid: null, exitCode: null, signalCode: null, drained: false, stdoutComplete: false, stdinComplete: false, stderrDrained: false, termination: null };
  const save = () => writeFileSync(destination, JSON.stringify(receipt, null, 2), { mode: 0o600 });
  writeFileSync(`${destination}.stdout.jsonl`, "", { mode: 0o600 });
  writeFileSync(`${destination}.stdin.jsonl`, "", { mode: 0o600 }); writeFileSync(`${destination}.stderr.bin`, "", { mode: 0o600 });
  const admission = process.env.BRAIN_SMART_PAID_ADMISSION ? JSON.parse(process.env.BRAIN_SMART_PAID_ADMISSION) : null;
  if (!admission && process.env.BRAIN_SMART_OFFLINE!=="1")throw Error("Explicit root per-turn paid admission required before native prompt");
  if (admission) {
    assertPaidPolicy(admission.policy, admission.binding);
    const local=new URL(process.env.ANTHROPIC_BASE_URL ?? "");
    if(local.protocol!=="http:" || local.hostname!=="127.0.0.1" || !local.port || !/^\/[a-f0-9]{64}$/.test(local.pathname) || local.username || local.password)throw Error("Protected per-session local relay absent before native prompt");
    receipt.localSessionSha=createHash("sha256").update(local.pathname.slice(1)).digest("hex");
    if(admission.policy.purpose!==process.env.BRAIN_SMART_SCOPE || (admission.policy.purpose==="review")!==readOnlyReview)throw Error("Root grant purpose differs from native scope");
    const grantBytes=readFileSync(admission.policy.consumedMarkerPath,"utf8"),grant=JSON.parse(grantBytes),sha=(text:string)=>createHash("sha256").update(text).digest("hex");
    if(sha(grantBytes)!==process.env.BRAIN_SMART_PAID_GRANT_SHA || grant.grantNonce!==admission.policy.grantNonce || grant.policySha!==sha(JSON.stringify(admission.policy)) || grant.bindingSha!==sha(JSON.stringify(admission.binding)) || grant.invoiceUsd!==null || !Number.isFinite(Date.parse(grant.claimedAtUtc)) || Date.parse(grant.claimedAtUtc)>Date.now())throw Error("Exact consumed root grant absent before native prompt");
    assertPaidPolicy(admission.policy,admission.binding,Date.parse(grant.claimedAtUtc));
  }
  receipt.grantSha = process.env.BRAIN_SMART_PAID_GRANT_SHA ?? null;
  receipt.executionKind = process.env.BRAIN_SMART_OFFLINE === "1" ? "offline-native-scripted" : "subscription-native-direct";
  receipt.admissionBinding = admission?.binding ?? null; receipt.paidPolicySha = admission ? createHash("sha256").update(JSON.stringify(admission.policy)).digest("hex") : null;
  save();
  const env = { ...process.env, ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL, ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
    ANTHROPIC_SMALL_FAST_MODEL: MODEL, ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL,
    CLAUDE_CODE_SUBAGENT_MODEL: MODEL, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" };
  const native = Bun.spawn([...command, ...args], { cwd: process.cwd(), env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  receipt.nativePid = native.pid; save();
  const input = (async () => {
    const decoder = new StringDecoder("utf8"); let buffer = "";
    for await (const bytes of Bun.stdin.stream()) {
      appendFileSync(`${destination}.stdin.jsonl`, bytes);
      buffer += decoder.write(Buffer.from(bytes));
      const lines = buffer.split("\n"); buffer = lines.pop()!;
      for (const line of lines) {
        const event = JSON.parse(line);
        if (event.type === "user") {
          if (admission) { const actual = (await import("node:crypto")).createHash("sha256").update(event.message?.content ?? "").digest("hex"); if (actual !== admission.binding.promptSha) throw Error("Native input differs from root paid prompt binding"); }
          receipt.promptReleased = true; save(); }
        native.stdin.write(`${line}\n`); native.stdin.flush();
      }
    }
    buffer += decoder.end(); if (buffer) native.stdin.write(buffer);
    native.stdin.end(); receipt.stdinComplete = true; save();
  })().catch(error => { receipt.inputFailure = String(error); save(); });
  const stderr = (async () => {
    for await (const bytes of native.stderr) { appendFileSync(`${destination}.stderr.bin`, bytes); process.stderr.write(bytes); }
    receipt.stderrDrained = true;
  })().catch(error => { receipt.stderrFailure = String(error); save(); });
  async function closeFailedNative() {
    receipt.termination = { requested: "SIGTERM", forced: false, timedOut: false }; save();
    native.kill("SIGTERM");
    let exitCode = await bounded(native.exited, 1000);
    if (exitCode === undefined) {
      receipt.termination.forced = true; native.kill("SIGKILL");
      exitCode = await bounded(native.exited, 1000);
    }
    if (exitCode === undefined) receipt.termination.timedOut = true;
    else { receipt.exitCode = exitCode; receipt.signalCode = native.signalCode; }
    await bounded(stderr, 1000);
    await bounded(stdout, 1000);
    receipt.drained = exitCode !== undefined && receipt.stdoutComplete && receipt.stderrDrained;
    save();
  }
  const decoder = new StringDecoder("utf8"); let buffer = "";
  function observe(line: string) {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === "control_response") {
      if (event.response?.request_id === "brain-initialize") receipt.account = event.response?.response?.account;
      if (event.response?.request_id === "brain-settings") receipt.settings = event.response?.response;
    }
    if (event.type === "system" && event.subtype === "init") {
      receipt.init = event;
      if (event.model !== MODEL || event.apiKeySource !== "none" || event.claude_code_version !== "2.1.283") throw Error("Actual native model/auth mismatch");
      if(event.permissionMode!=="default")throw Error("Actual native permission mode differs from root default");
    }
    if (event.type === "rate_limit_event") {
      receipt.rates.push(event);
      const info = event.rate_limit_info;
      receipt.overage = info?.isUsingOverage === true || info?.overageInUse === true ? "active observed" : info?.isUsingOverage === false || info?.overageInUse === false ? "inactive observed" : "unknown";
      if (!overageAllowed(info, admission !== null)) throw Error("Rate/paid-policy refusal; stop");
      if (admission) assertPaidPolicy(admission.policy, admission.binding, Date.parse(receipt.startedAtUtc));
    }
    if (event.type === "result") {
      receipt.result = event; receipt.apiEquivalent = priceSonnet55Usage(event);
      if (event.is_error) throw Error("Native result reported an error");
    }
    save();
  }
  let transportFailure: unknown = null;
  let refuse!: () => void;
  const refusal = new Promise<"refused">((resolve) => { refuse = () => resolve("refused"); });
  const stdout = (async () => {
    for await (const bytes of native.stdout) {
      appendFileSync(`${destination}.stdout.jsonl`, bytes);
      if (transportFailure === null) {
        try {
          buffer += decoder.write(Buffer.from(bytes));
          const lines = buffer.split("\n"); buffer = lines.pop()!;
          for (const line of lines) observe(line);
          process.stdout.write(bytes);
        } catch (error) { transportFailure = error; refuse(); }
      }
      // A refused/malformed event still drains all literal owned stdout bytes.
    }
    if (transportFailure === null) {
      try { buffer += decoder.end(); if (buffer.trim()) observe(buffer); }
      catch (error) { transportFailure = error; refuse(); }
    }
    receipt.stdoutComplete = true; save();
  })().catch(error => { transportFailure = error; refuse(); });
  try {
    const deadline = process.env.BRAIN_SMART_OFFLINE === "1" && process.env.BRAIN_SMART_OFFLINE_DEADLINE_MS ? Number(process.env.BRAIN_SMART_OFFLINE_DEADLINE_MS) : Number(process.env.BRAIN_SMART_NATIVE_DEADLINE_MS ?? (readOnlyReview ? 290000 : 180000));
    if (!Number.isSafeInteger(deadline) || deadline < 50 || deadline > 290000) throw Error("Invalid native observer deadline");
    const status = await bounded(Promise.race([Promise.all([stdout, input, stderr, native.exited]).then(() => "closed"), refusal]), deadline);
    if (status !== "closed") throw transportFailure ?? Error("Native transport deadline expired");
    receipt.exitCode = await native.exited; receipt.signalCode = native.signalCode;
    receipt.drained = receipt.stdoutComplete && receipt.stderrDrained;
    if (transportFailure || receipt.inputFailure || receipt.stderrFailure) throw Error("Native transport input/stdout/stderr did not flush");
    if (receipt.exitCode !== 0 || !receipt.result || !receipt.init) throw Error("Native EOF/exit without complete usage receipt");
    receipt.overage = receipt.rates.some((r: any) => r.rate_limit_info?.isUsingOverage === true || r.rate_limit_info?.overageInUse === true) ? "active observed" : receipt.rates.length && receipt.rates.every((r: any) => r.rate_limit_info?.isUsingOverage === false || r.rate_limit_info?.overageInUse === false) ? "inactive observed" : "unknown";
    receipt.additionalBilledUsd = null; // Route flags are not an invoice.
  } catch (error) {
    receipt.failure = String(error); process.exitCode = 1;
    await closeFailedNative();
  } finally { receipt.durationMs = performance.now() - receipt.startedAt; receipt.finishedAtUtc = new Date(Date.now()).toISOString(); receipt.finished = receipt.drained; save(); }
  // On refusal the real runner may still hold stdin open awaiting a response.
  // Exit only after the owned native process has a recorded bounded close attempt.
  if (process.exitCode === 1) process.exit(1);
}
if (import.meta.main) await main();
