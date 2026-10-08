/** Actual core Claude runner transport tee; authentication remains in cli-runners. */
import { StringDecoder } from "node:string_decoder";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { priceSonnet55Usage } from "../../measure-sonnet55-cost";

export const MODEL = "claude-sonnet-5-5";
async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), milliseconds); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
async function main() {
  if (process.env.BRAIN_LIVE_EVAL !== "846" && process.env.BRAIN_SPEAKING_OFFLINE !== "1") throw Error("Explicit #846 dispatch required");
  const destination = process.env.BRAIN_SPEAKING_RECEIPT;
  const source = process.env.BRAIN_SPEAKING_SOURCE;
  if (!destination || !source || !process.env.BRAIN_ROOT) throw Error("Missing isolated observer paths");
  const command = JSON.parse(process.env.BRAIN_SPEAKING_NATIVE_COMMAND ?? "null") as string[];
  if (!Array.isArray(command) || !command.length || command.some(v => typeof v !== "string")) throw Error("Require exact native argv prefix");
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) throw Error("Subscription token required; API credentials refused");
  const args = process.argv.slice(2);
  const index = args.indexOf("--settings");
  if (index < 0 || !args[index + 1]) throw Error("Actual core neutralised settings are absent");
  const settings = JSON.parse(args[index + 1]!);
  settings.autoMemoryEnabled = false;
  settings.hooks = { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: `python3 ${JSON.stringify(join(source, "scripts/evals/speaking-lifecycle/tool-hook.py"))}` }] }] };
  args[index + 1] = JSON.stringify(settings);
  const readOnlyReview = process.env.BRAIN_SPEAKING_READONLY_REVIEW === "1";
  args.push("--model", MODEL, "--no-session-persistence", "--max-turns", readOnlyReview ? "1" : "20");
  if (readOnlyReview) args.push("--tools", "", "--effort", "low");
  const receipt: any = { model: MODEL, promptReleased: false, result: null, init: null,
    rates: [], account: null, settings: null, apiEquivalent: null, failure: null,
    additionalBilledUsd: null, overage: "unknown", startedAt: performance.now(), finished: false,
    firstFrameMs:null,firstAssistantMs:null,promptReleasedAtMs:null,toolCalls:[],nativePid: null, exitCode: null, signalCode: null, drained: false, stdoutComplete: false, stderrDrained: false, stdoutDrained: false, termination: null };
  const save = () => writeFileSync(destination, JSON.stringify(receipt, null, 2), { mode: 0o600 });
  for (const suffix of ["stdout.jsonl", "stdin.jsonl", "stderr.bin"]) writeFileSync(`${destination}.${suffix}`, "", { mode: 0o600 }); save();
  const env = { ...process.env, ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL, ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
    ANTHROPIC_SMALL_FAST_MODEL: MODEL, ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL,
    CLAUDE_CODE_SUBAGENT_MODEL: MODEL, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" };
  // Bun's installed declaration specifies setsid/process-group leadership.
  // A native CLI group-wide teardown must not terminate this receipt observer.
  const native = Bun.spawn([...command, ...args], { cwd: process.cwd(), env, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true });
  receipt.nativePid = native.pid; save();
  function killOwnedGroup(signal: NodeJS.Signals): boolean {
    try { process.kill(-native.pid, signal); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  }
  let forcedDeadline: ReturnType<typeof setTimeout> | undefined;
  // Close our native child and retain receipts BEFORE the outer core runner's
  // 180/300s safety deadline can terminate this observer.
  const offlineDeadline = Number(process.env.BRAIN_SPEAKING_OBSERVER_DEADLINE_MS);
  const deadlineMs = process.env.BRAIN_SPEAKING_OFFLINE === "1" && Number.isFinite(offlineDeadline) && offlineDeadline >= 10
    ? Math.min(offlineDeadline, 170_000) : readOnlyReview ? 290_000 : 170_000;
  const deadline = setTimeout(() => {
    receipt.failure = "Native observation deadline";
    receipt.termination = { requested: "SIGTERM", forced: false, timedOut: true }; save();
    killOwnedGroup("SIGTERM");
    forcedDeadline = setTimeout(() => {
      if (killOwnedGroup("SIGKILL")) { receipt.termination.forced = true; save(); }
    }, 1000);
  }, deadlineMs);
  const input = (async () => {
    const decoder = new StringDecoder("utf8"); let buffer = "";
    for await (const bytes of Bun.stdin.stream()) {
      appendFileSync(`${destination}.stdin.jsonl`, bytes);
      buffer += decoder.write(Buffer.from(bytes));
      const lines = buffer.split("\n"); buffer = lines.pop()!;
      for (const line of lines) {
        const event = JSON.parse(line);
        if (event.type === "user") { receipt.promptReleased = true; receipt.promptReleasedAtMs=performance.now()-receipt.startedAt; save(); }
        native.stdin.write(`${line}\n`); native.stdin.flush();
      }
    }
    buffer += decoder.end(); if (buffer) native.stdin.write(buffer);
    native.stdin.end();
  })().catch(error => { receipt.inputFailure = String(error); save(); });
  const stderr = (async () => {
    for await (const bytes of native.stderr) { appendFileSync(`${destination}.stderr.bin`, bytes); process.stderr.write(bytes); }
    receipt.stderrDrained = true;
  })().catch(error => { receipt.stderrFailure = String(error); save(); });
  async function closeFailedNative() {
    receipt.termination ??= { requested: "SIGTERM", forced: false, timedOut: false }; save();
    killOwnedGroup("SIGTERM");
    let exitCode = await bounded(native.exited, 1000);
    if (exitCode === undefined) {
      receipt.termination.forced = true; killOwnedGroup("SIGKILL");
      exitCode = await bounded(native.exited, 1000);
    }
    if (exitCode === undefined) receipt.termination.timedOut = true;
    else { receipt.exitCode = exitCode; receipt.signalCode = native.signalCode; }
    await bounded(stderr, 1000);
    if (!receipt.stderrDrained && killOwnedGroup("SIGKILL")) { receipt.termination.forced = true; await bounded(stderr, 1000); }
    receipt.drained = exitCode !== undefined && receipt.stderrDrained;
    save();
  }
  const decoder = new StringDecoder("utf8"); let buffer = "";
  function observe(line: string) {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    receipt.firstFrameMs??=performance.now()-receipt.startedAt;
    if(event.type==="assistant"){receipt.firstAssistantMs??=performance.now()-receipt.startedAt;for(const block of event.message?.content??[])if(block.type==="tool_use"&&!receipt.toolCalls.some((call:any)=>call.id===block.id))receipt.toolCalls.push({id:block.id,name:block.name,atMs:performance.now()-receipt.startedAt});}
    if (event.type === "control_response") {
      if (event.response?.request_id === "brain-initialize") receipt.account = event.response?.response?.account;
      if (event.response?.request_id === "brain-settings") receipt.settings = event.response?.response;
    }
    if (event.type === "system" && event.subtype === "init") {
      receipt.init = event;
      if (event.model !== MODEL || event.apiKeySource !== "none" || event.claude_code_version !== "2.1.293") throw Error("Actual native model/auth mismatch");
    }
    if (event.type === "rate_limit_event") {
      receipt.rates.push(event);
      if (event.rate_limit_info?.isUsingOverage === true || event.rate_limit_info?.overageInUse === true) {
        receipt.overage = "active"; throw Error("Reported subscription overage; stop");
      }
    }
    if (event.type === "result") {
      receipt.result = event; receipt.apiEquivalent = priceSonnet55Usage(event);
      if (event.is_error) throw Error("Native result reported an error");
    }
    save();
  }
  const stdoutReader=native.stdout.getReader();
  try {
    for (;;) {
      const next=await stdoutReader.read();if(next.done)break;const bytes=next.value;
      appendFileSync(`${destination}.stdout.jsonl`, bytes);
      buffer += decoder.write(Buffer.from(bytes));
      const lines = buffer.split("\n"); buffer = lines.pop()!;
      for (const line of lines) observe(line);
      process.stdout.write(bytes);
    }
    buffer += decoder.end(); if (buffer.trim()) observe(buffer);
    receipt.stdoutComplete = true; receipt.stdoutDrained = true;
    if (receipt.failure) throw Error(receipt.failure);
    await Promise.all([input, stderr]);
    receipt.exitCode = await native.exited; receipt.signalCode = native.signalCode;
    receipt.drained = receipt.stderrDrained;
    if (receipt.failure) throw Error(receipt.failure);
    if (receipt.inputFailure || receipt.stderrFailure) throw Error("Native transport input/stderr did not flush");
    if (receipt.exitCode !== 0 || !receipt.result || !receipt.init) throw Error("Native EOF/exit without complete usage receipt");
    receipt.overage = receipt.rates.length && receipt.rates.every((r: any) => r.rate_limit_info?.isUsingOverage === false || r.rate_limit_info?.overageInUse === false) ? "inactive observed" : "unknown";
    // A reported inactive overage route is not an invoice or a zero-charge receipt.
    receipt.additionalBilledUsd = null;
  } catch (error) {
    receipt.failure = String(error); process.exitCode = 1;
    await closeFailedNative();
    // Retain all remaining bytes from the owned closed child, even after semantic refusal.
    const remaining=(async()=>{for(;;){const next=await stdoutReader.read();if(next.done)break;appendFileSync(`${destination}.stdout.jsonl`,next.value);process.stdout.write(next.value);}return true;})();
    try {
      let drained=await bounded(remaining,1000);
      if(drained===undefined){if(killOwnedGroup("SIGKILL")){receipt.termination.forced=true;}drained=await bounded(remaining,1000);}
      receipt.stdoutDrained=drained===true;
      if(!receipt.stdoutDrained){receipt.stdoutDrainFailure="Owned stdout did not reach bounded EOF";await stdoutReader.cancel("Owned bounded drain expired");}
    }catch(error){receipt.stdoutDrainFailure=String(error);}
  } finally {
    stdoutReader.releaseLock();
    clearTimeout(deadline); if (forcedDeadline !== undefined) clearTimeout(forcedDeadline);
    receipt.durationMs = performance.now() - receipt.startedAt; receipt.finished = receipt.drained; save();
  }
  // On refusal the real runner may still hold stdin open awaiting a response.
  // Exit only after the owned native process has a recorded bounded close attempt.
  if (process.exitCode === 1) process.exit(1);
}
if (import.meta.main) await main();
