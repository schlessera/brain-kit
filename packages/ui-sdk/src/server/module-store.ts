/** Host-owned dependency generations, outside the managed brain subvolume. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isWithin } from "@schlessera/brain-common/internal/safe-path";

export interface ModuleGeneration { generation: string; lockHash: string; trigger: string; installedAt: string }
export const moduleStorePath = (brain: string) => join(dirname(brain), "modules");
export const moduleLockHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const generationName = (name: string) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(name);
function ownedDirectory(path: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path || ![0, process.geteuid!()].includes(info.uid) || (info.mode & 0o022)) throw Error("Module store must be a host-owned unaliased directory");
}
/** Re-read current publication. A malformed receipt is a named maintenance failure, never a generation. */
export function currentModuleGeneration(brain: string): ModuleGeneration | undefined {
  const store = moduleStorePath(brain);
  if (!lstatSync(store, { throwIfNoEntry: false })) return undefined;
  ownedDirectory(store);
  const current = join(store, "current.json");
  if (!lstatSync(current, { throwIfNoEntry: false })) return undefined;
  const info = lstatSync(current);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || ![0, process.geteuid!()].includes(info.uid) || (info.mode & 0o022)) throw Error("Invalid module generation publication");
  const receipt = JSON.parse(readFileSync(current, "utf8")) as ModuleGeneration;
  if (!generationName(receipt.generation) || !/^[0-9a-f]{64}$/.test(receipt.lockHash) || typeof receipt.trigger !== "string" || typeof receipt.installedAt !== "string") throw Error("Invalid module generation receipt");
  const generation = join(store, receipt.generation);
  ownedDirectory(generation); ownedDirectory(join(generation, "node_modules"));
  if (lstatSync(generation, { bigint: true }).dev === lstatSync(brain, { bigint: true }).dev
    || lstatSync(join(generation, "node_modules"), { bigint: true }).dev !== lstatSync(generation, { bigint: true }).dev) throw Error("Module store must be outside the brain filesystem/subvolume");
  if (readFileSync(join(generation, "receipt.json"), "utf8") !== JSON.stringify(receipt)) throw Error("Module generation receipt differs from publication");
  return receipt;
}
const moduleWorkerInputs = new WeakMap<object, HeldModuleGeneration>();
const heldGenerations = new WeakSet<HeldModuleGeneration>();
/** Opaque capability survives host-side sandbox copies; layout facts cannot mint it. */
export function moduleWorkerInput(held: HeldModuleGeneration): object {
  if (!heldGenerations.has(held)) throw Error("Unknown module generation holder");
  const token = Object.freeze({}); moduleWorkerInputs.set(token, held); return token;
}
export function moduleWorkerMounts(token: object | undefined, target: string): string[] {
  if (!token) return [];
  const held = moduleWorkerInputs.get(token);
  if (!held) throw Error("Unknown module worker input");
  return held.mounts(target);
}
export interface HeldModuleGeneration { readonly receipt: ModuleGeneration; readonly source: string; mounts(target: string): string[]; release(): void }
/** Pin exactly the publication selected at startup; retaining a view never selects again. */
export function holdModuleGeneration(brain: string): HeldModuleGeneration | undefined {
  const receipt = currentModuleGeneration(brain);
  if (!receipt) return undefined;
  const store = moduleStorePath(brain), source = join(store, receipt.generation, "node_modules");
  const identity = lstatSync(source, { bigint: true });
  const holders = join(store, "holders"); mkdirSync(holders, { recursive: true, mode: 0o700 }); ownedDirectory(holders);
  const lease = join(holders, `${randomUUID()}.json`);
  writeFileSync(lease, JSON.stringify({ generation: receipt.generation, pid: process.pid }), { flag: "wx", mode: 0o600 });
  let released = false;
  const held: HeldModuleGeneration = { receipt, source,
    mounts(target) {
      if (released) throw Error("Module generation holder is closed");
      const current = lstatSync(source, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) throw Error("Held module generation changed before launch");
      return ["--ro-bind", source, join(target, "node_modules")];
    },
    release() { if (!released) { unlinkSync(lease); released = true; } },
  };
  heldGenerations.add(held); return held;
}
/** Validate once before publication. Package-bin symlinks may only stay within this generation. */
export function validateModuleGeneration(root: string): void {
  const modules = join(root, "node_modules"), device = lstatSync(root, { bigint: true }).dev;
  ownedDirectory(modules);
  let entries = 0;
  function walk(path: string, depth: number): void {
    if (depth > 256 || ++entries > 200_000) throw Error("Module generation exceeds validation bounds");
    const info = lstatSync(path, { bigint: true });
    if (info.dev !== device || ![0, process.geteuid!()].includes(Number(info.uid))) throw Error("Module generation has foreign storage or ownership");
    if (info.isSymbolicLink()) {
      if (!isWithin(modules, realpathSync(path))) throw Error("Module generation symlink leaves its protected mount");
    } else if (info.isDirectory()) {
      if (Number(info.mode) & 0o022) throw Error("Module generation directory is writable by others");
      for (const name of readdirSync(path)) walk(join(path, name), depth + 1);
    } else if (!info.isFile() || info.nlink !== 1n || (Number(info.mode) & 0o022)) throw Error("Module generation contains an unprotected file");
  }
  walk(modules, 0);
}
/** Atomic publication after complete validation; the old pointer survives every earlier failure. */
export function publishModuleGeneration(brain: string, receipt: ModuleGeneration): string | undefined {
  if (!generationName(receipt.generation)) throw Error("Invalid module generation identity");
  const store = moduleStorePath(brain), root = join(store, receipt.generation);
  ownedDirectory(store); ownedDirectory(root);
  if (lstatSync(root, { bigint: true }).dev === lstatSync(brain, { bigint: true }).dev) throw Error("Module generation shares the brain filesystem/subvolume");
  validateModuleGeneration(root);
  const bytes = JSON.stringify(receipt);
  const durable = (path: string, data: string) => {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  };
  durable(join(root, "receipt.json"), bytes);
  const pending = join(store, `.current-${randomUUID()}`);
  try {
    durable(pending, bytes);
    const fd = openSync(store, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      renameSync(pending, join(store, "current.json"));
      // Rename is the publication point. A later directory-sync failure must
      // never make the caller remove the generation now named by current.
      try { fsyncSync(fd); } catch (error) { return `Generation activated; publication durability is uncertain: ${String(error)}`; }
    } finally { closeSync(fd); }
  } finally { rmSync(pending, { force: true }); }
}
/** Later maintenance collects superseded generations only after every holder releases. Unknown leases retain storage. */
export function collectModuleGenerations(brain: string): string[] {
  const current = currentModuleGeneration(brain), store = moduleStorePath(brain);
  if (!current) return [];
  const held = new Set<string>();
  const holders = join(store, "holders");
  if (lstatSync(holders, { throwIfNoEntry: false })) for (const name of readdirSync(holders)) {
    const lease = JSON.parse(readFileSync(join(holders, name), "utf8")) as { generation?: string };
    if (!lease.generation || !generationName(lease.generation)) throw Error("Unknown module holder; collection withheld");
    held.add(lease.generation);
  }
  const collected: string[] = [];
  for (const name of readdirSync(store)) if (generationName(name) && name !== current.generation && !held.has(name)) {
    const root = join(store, name); ownedDirectory(root);
    rmSync(root, { recursive: true }); collected.push(name);
  }
  return collected;
}
