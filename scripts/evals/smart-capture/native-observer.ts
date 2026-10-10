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
    additionalBilledUsd: null, overage: "unknown", startedAt: performance.now(), finished: false,
    nativePid: null, exitCode: null, signalCode: null, drained: false, stdoutComplete: false, stderrDrained: false, termination: null };
  const save = () => writeFileSync(destination, JSON.stringify(receipt, null, 2), { mode: 0o600 });
  writeFileSync(`${destination}.stdout.jsonl`, "", { mode: 0o600 }); save();
  const env = { ...process.env, ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL, ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
    ANTHROPIC_SMALL_FAST_MODEL: MODEL, ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL,
    CLAUDE_CODE_SUBAGENT_MODEL: MODEL, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" };
  const native = Bun.spawn([...command, ...args], { cwd: process.cwd(), env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  receipt.nativePid = native.pid; save();
  const input = (async () => {
    const decoder = new StringDecoder("utf8"); let buffer = "";
    for await (const bytes of Bun.stdin.stream()) {
      buffer += decoder.write(Buffer.from(bytes));
      const lines = buffer.split("\n"); buffer = lines.pop()!;
      for (const line of lines) {
        const event = JSON.parse(line);
        if (event.type === "user") { receipt.promptReleased = true; save(); }
        native.stdin.write(`${line}\n`); native.stdin.flush();
      }
    }
    buffer += decoder.end(); if (buffer) native.stdin.write(buffer);
    native.stdin.end();
  })().catch(error => { receipt.inputFailure = String(error); save(); });
  const stderr = (async () => {
    for await (const bytes of native.stderr) process.stderr.write(bytes);
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
    receipt.drained = exitCode !== undefined && receipt.stderrDrained;
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
  try {
    for await (const bytes of native.stdout) {
      appendFileSync(`${destination}.stdout.jsonl`, bytes);
      buffer += decoder.write(Buffer.from(bytes));
      const lines = buffer.split("\n"); buffer = lines.pop()!;
      for (const line of lines) observe(line);
      process.stdout.write(bytes);
    }
    buffer += decoder.end(); if (buffer.trim()) observe(buffer);
    receipt.stdoutComplete = true;
    await Promise.all([input, stderr]);
    receipt.exitCode = await native.exited; receipt.signalCode = native.signalCode;
    receipt.drained = receipt.stderrDrained;
    if (receipt.inputFailure || receipt.stderrFailure) throw Error("Native transport input/stderr did not flush");
    if (receipt.exitCode !== 0 || !receipt.result || !receipt.init) throw Error("Native EOF/exit without complete usage receipt");
    receipt.overage = receipt.rates.length && receipt.rates.every((r: any) => r.rate_limit_info?.isUsingOverage === false || r.rate_limit_info?.overageInUse === false) ? "inactive observed" : "unknown";
    if (receipt.overage === "inactive observed") receipt.additionalBilledUsd = 0;
  } catch (error) {
    receipt.failure = String(error); process.exitCode = 1;
    await closeFailedNative();
  } finally { receipt.durationMs = performance.now() - receipt.startedAt; receipt.finished = receipt.drained; save(); }
  // On refusal the real runner may still hold stdin open awaiting a response.
  // Exit only after the owned native process has a recorded bounded close attempt.
  if (process.exitCode === 1) process.exit(1);
}
if (import.meta.main) await main();
