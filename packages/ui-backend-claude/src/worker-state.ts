/** Parent-owned snapshots; the runtime never mounts the host's saved state writable. */
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { WorkerHostError } from "@schlessera/brain-ui-sdk/internal";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const MAX_STATE_BYTES = 128 * 1024 * 1024;

function regular(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_STATE_BYTES) throw new WorkerHostError("runtime state contains an alias, special file or oversized file");
    const bytes = readFileSync(fd);
    if (bytes.length > MAX_STATE_BYTES) throw new WorkerHostError("runtime state exceeds its byte bound");
    return bytes;
  } finally { closeSync(fd); }
}
function directory(path: string): void {
  if (existsSync(path)) {
    if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) throw new WorkerHostError("runtime state directory is redirected");
  } else {
    directory(dirname(path)); mkdirSync(path, { mode: 0o700 });
  }
}
function files(root: string, prefix = ""): string[] {
  if (!existsSync(root)) return [];
  if (!lstatSync(root).isDirectory() || realpathSync(root) !== root) throw new WorkerHostError("runtime state directory is redirected");
  const result: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name), rel = prefix ? `${prefix}/${name}` : name;
    const info = lstatSync(path);
    if (info.isDirectory()) result.push(...files(path, rel));
    else { regular(path); result.push(rel); }
    if (result.length > 10000) throw new WorkerHostError("runtime state exceeds its file bound");
  }
  return result;
}
export function createClaudeWorkerState(brainPath: string, env: Record<string, string | undefined>,
  options: { ephemeral?: boolean } = {}) {
  const brain = realpathSync(brainPath);
  const configured = resolve(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"));
  let ancestor = configured;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const canonical = resolve(realpathSync(ancestor), configured.slice(ancestor.length).replace(/^\//, ""));
  if (canonical === brain || canonical.startsWith(`${brain}/`) || brain.startsWith(`${canonical}/`))
    throw new WorkerHostError("Claude config and transcripts must be outside the authoritative brain and its ancestors");
  directory(configured);
  const saved = realpathSync(configured);
  if (saved === brain || saved.startsWith(`${brain}/`) || brain.startsWith(`${saved}/`))
    throw new WorkerHostError("Claude config and transcripts must be outside the authoritative brain and its ancestors");
  // Both fixtures and native CLI use the SDK's project-directory encoding.
  const project = `projects/${brain.replace(/[^a-zA-Z0-9]/g, "-")}`;
  const state = mkdtempSync("/dev/shm/brain-claude-state-");
  // An autonomous turn starts from nothing saved and saves nothing: no stored
  // login, settings, account file or transcript enters or leaves it (#676).
  if (options.ephemeral) return { path: state, persist() {}, cleanup: () => rmSync(state, { recursive: true, force: true }) };
  const initial = new Map<string, string>();
  try {
    let total = 0;
    const names = ["settings.json", ".credentials.json", ".claude.json"].filter(name => existsSync(join(saved, name)));
    names.push(...files(join(saved, project)).map(name => `${project}/${name}`));
    for (const name of names) {
      const bytes = regular(join(saved, name)); total += bytes.length;
      if (total > MAX_STATE_BYTES) throw new WorkerHostError("runtime state exceeds its byte bound");
      const target = join(state, name); directory(dirname(target)); writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
      initial.set(name, hash(bytes));
    }
    return {
      path: state,
      persist() {
        // Only this brain's native transcript files, never worker-supplied
        // commands, settings, destinations or deletion requests. The PID
        // namespace is already gone, so no runtime writer can race this copy.
        let total = 0;
        for (const file of files(join(state, project))) {
          if (!file.endsWith(".jsonl")) continue;
          const name = `${project}/${file}`, bytes = regular(join(state, name)); total += bytes.length;
          if (total > MAX_STATE_BYTES) throw new WorkerHostError("runtime transcripts exceed their byte bound");
          if (initial.get(name) === hash(bytes)) continue;
          const target = join(saved, name); directory(dirname(target));
          const present = existsSync(target) ? hash(regular(target)) : undefined;
          if (present !== initial.get(name)) throw new WorkerHostError("saved transcript changed concurrently; refusing overwrite");
          const temp = `${target}.${crypto.randomUUID()}.tmp`;
          try { writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 }); directory(dirname(target)); renameSync(temp, target); }
          finally { rmSync(temp, { force: true }); }
        }
      },
      cleanup: () => rmSync(state, { recursive: true, force: true }),
    };
  } catch (error) { rmSync(state, { recursive: true, force: true }); throw error; }
}
