/// <reference types="@vitest/browser-playwright" />
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import type { BrowserCommand } from "vitest/node";
import { watchdogMs } from "../../../../scripts/test-deadlines.ts";
type Op = { op: "start" } | { op: "read" | "release" | "stop"; id: string };
const servers = new Map<string, { child: ChildProcess; url: string; diagnostics: () => string }>();
export const clientTurnServer: BrowserCommand<[Op], unknown> = async (_ctx, input) => {
  if (input.op === "start") {
    const child = spawn(process.env.BUN_BIN ?? "bun", ["--preload", resolve("../../scripts/test-network-child-preload.ts"), resolve("../ui-react/tests/fixtures/client-turn-browser-server.ts")],
      { cwd: resolve("../.."), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stderr!.on("data", bytes => { stderr += String(bytes); });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Turn fixture startup timed out: ${stderr}`)), watchdogMs(30_000));
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("exit", (code, signal) => { clearTimeout(timer); reject(new Error(`Turn fixture exited ${code}/${signal}: ${stderr}`)); });
        child.stdout!.on("data", bytes => {
          stdout += String(bytes);
          if (!stdout.includes("\n")) return;
          clearTimeout(timer);
          try { resolve(JSON.parse(stdout.split("\n")[0]!).url); } catch (error) { reject(error); }
        });
      });
      const id = crypto.randomUUID(); servers.set(id, { child, url, diagnostics: () => stderr });
      return { id, url };
    } catch (error) {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const ended = once(child, "exit"); child.kill(); await ended;
      }
      throw error;
    }
  }
  const server = servers.get(input.id);
  if (!server) throw new Error("Unknown turn fixture");
  if (input.op === "stop") {
    const outcome = server.child.exitCode !== null || server.child.signalCode !== null
      ? [server.child.exitCode, server.child.signalCode]
      : await (async () => { const ended = once(server.child, "exit"); server.child.kill("SIGTERM"); return await ended; })();
    const [code, signal] = outcome; servers.delete(input.id);
    if (code !== 0 || signal !== null) throw new Error(`Turn fixture cleanup failed ${code}/${signal}: ${server.diagnostics()}`);
    return;
  }
  const response = await fetch(server.url, { method: input.op === "release" ? "POST" : "GET" });
  if (!response.ok) throw new Error(`Turn fixture failed ${response.status}: ${server.diagnostics()}`);
  return response.json();
};
declare module "vitest/browser" { interface BrowserCommands { clientTurnServer: (input: Op) => Promise<unknown> } }
