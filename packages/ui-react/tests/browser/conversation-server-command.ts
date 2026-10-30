/// <reference types="@vitest/browser-playwright" />
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import type { BrowserCommand } from "vitest/node";
type Op = { op: "start"; durable?:boolean; nativeHistory?:boolean; contextual?: boolean; holdOpening?: boolean; holdValidation?: boolean; missingSession?: boolean; delayedIdentity?: boolean; provider?: "gemini" | "gpt"; action?: "permitted" | "confirm" | "deny" } | { op: "step"; id: string; client: unknown[]; provider: unknown[]; release?: boolean; identify?: boolean; failHistory?: boolean; releaseOpening?: boolean; releaseValidation?: boolean; quota?:boolean; pressure?:boolean; finishDuring?:number; resultText?:string; backendTailQuota?:boolean; multipart?:boolean; backendPrefix?:string; seedLegacyVoice?:boolean; seedTypedHistory?:boolean; takeover?:boolean; parallelStarts?:boolean; parallelLeave?:boolean; restart?:boolean; engine?:"gemini"|"gpt" } | { op: "stop"; id: string };
const servers = new Map<string, { process: ChildProcess; url: string; diagnostics: () => string }>();
/** Native byte witnesses come from a real loopback server inside the pinned offline container. */
export const conversationServer: BrowserCommand<[Op], unknown> = async (_ctx, input) => {
  if (input.op === "start") {
    const child = spawn(process.env.BUN_BIN ?? "bun", ["--preload", resolve("../../scripts/test-network-child-preload.ts"), resolve(input.durable ? "../ui-react/tests/fixtures/dialogue-browser-server.ts" : input.contextual ? "../ui-react/tests/fixtures/contextual-conversation-browser-server.ts" : "../ui-react/tests/fixtures/conversation-browser-server.ts"), ...(input.contextual || input.durable ? [input.provider ?? "gpt", input.action ?? "permitted", input.delayedIdentity ? "delayed-identity" : "immediate-identity", ...(input.durable ? [input.nativeHistory === false ? "no-native-history" : "native-history"] : [input.missingSession ? "missing-session" : "known-session", input.holdOpening ? "held-opening" : "immediate-opening", input.holdValidation ? "held-validation" : "immediate-validation"])] : [])],
      { cwd: resolve("../.."), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stderr!.on("data", bytes => { stderr += String(bytes); });
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error(`Conversation fixture timed out: ${stderr}`)); }, 15_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", (code, signal) => { clearTimeout(timer); reject(new Error(`Conversation fixture exited ${code}/${signal}: ${stderr}`)); });
      child.stdout!.on("data", bytes => { stdout += String(bytes); if (stdout.includes("\n")) { clearTimeout(timer); try { resolve(JSON.parse(stdout.split("\n")[0]!).url); } catch (error) { reject(error); } } });
    });
    const id = crypto.randomUUID(); servers.set(id, { process: child, url, diagnostics: () => stderr }); return { id, url };
  }
  const server = servers.get(input.id); if (!server) throw new Error("Unknown conversation fixture");
  if (input.op === "step") {
    const response = await fetch(`${server.url}/fixture`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client: input.client, provider: input.provider, release: input.release, identify: input.identify, failHistory: input.failHistory, releaseOpening: input.releaseOpening, releaseValidation: input.releaseValidation, quota:input.quota, pressure:input.pressure, finishDuring:input.finishDuring, resultText:input.resultText, backendTailQuota:input.backendTailQuota, multipart:input.multipart, backendPrefix:input.backendPrefix, seedLegacyVoice:input.seedLegacyVoice, seedTypedHistory:input.seedTypedHistory, takeover:input.takeover, parallelStarts:input.parallelStarts, parallelLeave:input.parallelLeave, restart:input.restart, engine:input.engine }) });
    if (!response.ok) throw new Error(`Conversation fixture failed: ${response.status} ${server.diagnostics()}`);
    return response.json();
  }
  const ended = once(server.process, "exit"); server.process.kill("SIGTERM"); const [code, signal] = await ended;
  servers.delete(input.id); if (code !== 0 || signal !== null) throw new Error(`Conversation fixture cleanup failed ${code}/${signal}: ${server.diagnostics()}`);
};
declare module "vitest/browser" { interface BrowserCommands { conversationServer: (input: Op) => Promise<unknown> } }
