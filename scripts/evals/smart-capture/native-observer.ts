/** Actual core Claude runner transport tee; authentication remains in cli-runners. */
import { StringDecoder } from "node:string_decoder";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { priceSonnet55Usage } from "../../measure-sonnet55-cost";

export const MODEL = "claude-sonnet-5-5";
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
    additionalBilledUsd: null, overage: "unknown", startedAt: performance.now(), finished: false };
  const save = () => writeFileSync(destination, JSON.stringify(receipt, null, 2), { mode: 0o600 });
  writeFileSync(`${destination}.stdout.jsonl`, "", { mode: 0o600 }); save();
  const env = { ...process.env, ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL, ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
    ANTHROPIC_SMALL_FAST_MODEL: MODEL, ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL,
    CLAUDE_CODE_SUBAGENT_MODEL: MODEL, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" };
  const native = Bun.spawn([...command, ...args], { cwd: process.cwd(), env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
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
  })();
  const stderr = (async () => { for await (const bytes of native.stderr) process.stderr.write(bytes); })();
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
      if (event.model !== MODEL || event.apiKeySource !== "none") throw Error("Actual native model/auth mismatch");
    }
    if (event.type === "rate_limit_event") {
      receipt.rates.push(event);
      if (event.rate_limit_info?.isUsingOverage === true) throw Error("Reported subscription overage; stop");
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
    await Promise.all([input, stderr]);
    receipt.exitCode = await native.exited;
    if (receipt.exitCode !== 0 || !receipt.result || !receipt.init) throw Error("Native EOF/exit without complete usage receipt");
    receipt.overage = receipt.rates.some((r: any) => r.rate_limit_info?.isUsingOverage === false) ? "inactive observed" : "unknown";
    if (receipt.overage === "inactive observed") receipt.additionalBilledUsd = 0;
  } catch (error) {
    receipt.failure = String(error); native.kill(); process.exitCode = 1;
  } finally { receipt.durationMs = performance.now() - receipt.startedAt; receipt.finished = true; save(); }
}
if (import.meta.main) await main();
