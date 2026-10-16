/// <reference types="@vitest/browser-playwright" />
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import type { BrowserCommand } from "vitest/node";
type Op =
  | { op: "start" }
  | { op: "set"; id: string; patch: Record<string, unknown> }
  | { op: "stop"; id: string };
const servers = new Map<
  string,
  { process: ChildProcess; url: string; diagnostics: () => string }
>();
/** Storage byte witnesses come from a real loopback server inside the pinned offline container. */
export const storageServer: BrowserCommand<[Op], unknown> = async (
  _ctx,
  input
) => {
  if (input.op === "start") {
    const child = spawn(
      process.env.BUN_BIN ?? "bun",
      [
        "--preload",
        resolve("../../scripts/test-network-child-preload.ts"),
        resolve("../ui-react/tests/fixtures/storage-browser-server.ts"),
      ],
      {
        cwd: resolve("../.."),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let stdout = "",
      stderr = "";
    child.stderr!.on("data", (bytes) => {
      stderr += String(bytes);
    });
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Storage fixture timed out: ${stderr}`));
      }, 15_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(
          new Error(`Storage fixture exited ${code}/${signal}: ${stderr}`)
        );
      });
      child.stdout!.on("data", (bytes) => {
        stdout += String(bytes);
        if (stdout.includes("\n")) {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(stdout.split("\n")[0]!).url);
          } catch (error) {
            reject(error);
          }
        }
      });
    });
    const id = crypto.randomUUID();
    servers.set(id, { process: child, url, diagnostics: () => stderr });
    return { id, url };
  }
  const server = servers.get(input.id);
  if (!server) throw new Error("Unknown Storage fixture");
  if (input.op === "set") {
    const response = await fetch(`${server.url}/fixture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input.patch),
    });
    if (!response.ok)
      throw new Error(
        `Storage fixture failed: ${response.status} ${server.diagnostics()}`
      );
    return response.json();
  }
  const ended = once(server.process, "exit");
  server.process.kill("SIGTERM");
  const [code, signal] = await ended;
  servers.delete(input.id);
  if (code !== 0 || signal !== null)
    throw new Error(
      `Storage fixture cleanup failed ${code}/${signal}: ${server.diagnostics()}`
    );
};
declare module "vitest/browser" {
  interface BrowserCommands {
    storageServer: (input: Op) => Promise<unknown>;
  }
}
