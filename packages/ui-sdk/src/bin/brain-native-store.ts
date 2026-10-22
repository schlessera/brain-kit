#!/usr/bin/env bun
/** Host-owned entry point; never start this service from a brain repository. */
import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { serveNativeBrainManager, type NativeBrainManagerConfig } from "../server/native-brain-manager.js";
import { createNativeBrainManagerClient } from "../server/native-brain-manager-client.js";
import { nativeCheckpointId, NativeBrainManagerError } from "../server/native-brain-manager-protocol.js";

const usage = `Usage: brain-native-store /absolute/root-owned-config.json
       brain-native-store pool status /absolute/root-owned-config.json
       brain-native-store pool recovery [--after <id>] /absolute/root-owned-config.json
       brain-native-store pool release <id> /absolute/root-owned-config.json`;
function loadConfig(path: string): NativeBrainManagerConfig {
  if (process.getuid?.() !== 0 || !isAbsolute(path) || realpathSync(path) !== path)
    throw new Error("Native storage requires a root-run host service and a canonical absolute configuration path.");
  for (let directory = dirname(path); ; directory = dirname(directory)) {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022))
      throw new Error("Native storage configuration must have root-owned, non-writable ancestors.");
    if (directory === "/") break;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) || info.size > 16_384)
      throw new Error("Native storage configuration must be a bounded root-owned regular file, writable only by root.");
    return JSON.parse(readFileSync(fd, "utf8")) as NativeBrainManagerConfig;
  } finally { closeSync(fd); }
}
/**
 * Deterministic operator projection of the running manager's reference pool.
 * Exit 0 prints a result, exit 2 a usage error, exit 3 a manager refusal; every
 * result is one JSON object with `schema_version: 1`.
 */
async function pool(args: string[]): Promise<number> {
  const action = args[0], config = args.at(-1);
  const after = action === "recovery" && args.length === 4 && args[1] === "--after" ? args[2]! : null;
  const id = action === "release" && args.length === 3 ? args[1]! : null;
  const shaped = (action === "status" && args.length === 2) || (action === "recovery" && (args.length === 2 || after !== null)) || id !== null;
  if (!shaped || !config || (after !== null && !nativeCheckpointId.safeParse(after).success) || (id !== null && !nativeCheckpointId.safeParse(id).success)) {
    console.error(usage); return 2;
  }
  const fixed = loadConfig(config), client = createNativeBrainManagerClient({ socketPath: fixed.socketPath, timeoutMs: fixed.operationTimeoutMs });
  try {
    const result = action === "status" ? { action, status: await client.poolStatus() }
      : action === "recovery" ? { action, ...(await client.listPoolRecovery(after)) }
      : { action, record: await client.poolRelease(id!) };
    console.log(JSON.stringify({ schema_version: 1, ok: true, ...result }));
    return 0;
  } catch (error) {
    if (!(error instanceof NativeBrainManagerError)) throw error;
    console.log(JSON.stringify({ schema_version: 1, ok: false, action, code: error.code, message: error.message }));
    return 3;
  }
}
async function main() {
  if (process.argv[2] === "pool") return pool(process.argv.slice(3));
  if (process.argv.length !== 3 || process.argv[2] === "--help") {
    console.log(usage); return process.argv[2] === "--help" ? 0 : 2;
  }
  const service = await serveNativeBrainManager(loadConfig(process.argv[2]!));
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void service.close().then(() => process.exit(0), error => { console.error(String(error)); process.exit(1); });
  };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  console.log("Native brain storage is ready.");
  return undefined;
}
try { const code = await main(); if (code !== undefined) process.exitCode = code; }
catch (error) { console.error(String(error)); process.exitCode = 1; }
