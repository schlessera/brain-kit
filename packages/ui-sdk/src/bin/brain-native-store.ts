#!/usr/bin/env bun
/** Host-owned entry point; never start this service from a brain repository. */
import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { serveNativeBrainManager, type NativeBrainManagerConfig } from "../server/native-brain-manager.js";

const usage = "Usage: brain-native-store /absolute/root-owned-config.json";
async function main() {
  if (process.argv.length !== 3 || process.argv[2] === "--help") {
    console.log(usage); return process.argv[2] === "--help" ? 0 : 2;
  }
  const path = process.argv[2]!;
  if (process.getuid?.() !== 0 || !isAbsolute(path) || realpathSync(path) !== path)
    throw new Error("Native storage requires a root-run host service and a canonical absolute configuration path.");
  for (let directory = dirname(path); ; directory = dirname(directory)) {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022))
      throw new Error("Native storage configuration must have root-owned, non-writable ancestors.");
    if (directory === "/") break;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let config: NativeBrainManagerConfig;
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) || info.size > 16_384)
      throw new Error("Native storage configuration must be a bounded root-owned regular file, writable only by root.");
    config = JSON.parse(readFileSync(fd, "utf8")) as NativeBrainManagerConfig;
  } finally { closeSync(fd); }
  const service = await serveNativeBrainManager(config);
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
