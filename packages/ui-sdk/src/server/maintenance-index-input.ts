/** Fixed disposable SQLite family copy-up inside an already attested stage. */
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeSync, fchmodSync } from "node:fs";
import { INDEX_DIR, INDEX_FAMILY } from "@schlessera/brain-common/internal/index-location";
import { maintenanceOutputRoot } from "../config/env.js";
import { randomUUID } from "node:crypto";
const names = INDEX_FAMILY;
const stamp = (s: ReturnType<typeof fstatSync>) => [s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join(":");
/** No caller-selected paths; the executable's root is the existing maintenance output. */
export function prepareMaintenanceIndex(root: string, maximum: number): void {
  if (!Number.isSafeInteger(maximum) || maximum < 4096) throw Error("Invalid disposable index bound");
  const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  // The family lives in its own directory below the stage root. A stage with
  // no index directory has nothing to copy up: the writer creates it.
  const stage = openSync(root, DIRECTORY);
  let directory: number;
  try { directory = openSync(`/proc/self/fd/${stage}/${INDEX_DIR}`, DIRECTORY); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  finally { closeSync(stage); }
  const at = (name: string) => `/proc/self/fd/${directory}/${name}`;
  const inputs: { name: typeof names[number]; fd: number; identity: string; mode: number; size: number; owned: boolean }[] = [];
  let temporary: string | undefined;
  try {
    let total = 0;
    for (const name of names) {
      const info = lstatSync(at(name), { throwIfNoEntry: false });
      if (!info) continue;
      if (!info.isFile() || info.nlink !== 1 || !(info.mode & 0o200) || (info.mode & 0o7000)) throw Error("Unsupported disposable index member");
      total += info.size;
      if (!Number.isSafeInteger(total) || total > maximum) throw Error("Disposable index exceeds stage allowance");
      const fd = openSync(at(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const held = fstatSync(fd);
      inputs.push({ name, fd, identity: stamp(info), mode: info.mode & 0o777, size: info.size, owned: info.uid === process.getuid?.() });
      if (stamp(held) !== stamp(info)) throw Error("Changed disposable index member");
      if (name === "brain.db-journal" && info.size >= 16) {
        const tail = Buffer.alloc(16);
        if (readSync(fd, tail, 0, 16, info.size - 16) !== 16) throw Error("Short disposable index journal");
        // SQLite pager.c readSuperJournal: refuse a conservative superset,
        // without reading or following the embedded cross-database filename.
        if (tail.subarray(8).equals(Buffer.from("d9d505f920a163d7", "hex")) && tail.readUInt32BE(0) > 0)
          throw Error("Attached-database index recovery is unsupported");
      }
    }
    if (inputs.length && inputs[0]!.name !== "brain.db") throw Error("Orphan disposable index sidecar");
    if (!inputs.some(input => !input.owned)) return;
    // Name the directory for cleanup only once it exists, so a refused mkdir
    // (an index directory this identity cannot write) keeps its own error.
    const name = `.brain-maintenance-index-${randomUUID()}`;
    mkdirSync(at(name), { mode: 0o700 });
    temporary = name;
    const buffer = Buffer.alloc(64 * 1024);
    // Finish every copy and check the entire source family before replacement.
    for (const input of inputs.filter(input => !input.owned)) {
      const fd = openSync(at(`${temporary}/${input.name}`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        let position = 0;
        while (position < input.size) {
          const count = readSync(input.fd, buffer, 0, Math.min(buffer.length, input.size - position), position);
          if (!count) throw Error("Short disposable index input");
          let written = 0;
          while (written < count) { const size = writeSync(fd, buffer, written, count - written); if (!size) throw Error("Short disposable index output"); written += size; }
          position += count;
        }
        fchmodSync(fd, input.mode);
      } finally { closeSync(fd); }
    }
    for (const name of names) {
      const input = inputs.find(input => input.name === name), current = lstatSync(at(name), { throwIfNoEntry: false });
      if (input ? !current || stamp(current) !== input.identity || stamp(fstatSync(input.fd)) !== input.identity : current)
        throw Error("Changed disposable index family");
    }
    for (const input of inputs.filter(input => !input.owned)) renameSync(at(`${temporary}/${input.name}`), at(input.name));
  } finally {
    try { if (temporary) rmSync(at(temporary), { recursive: true }); }
    finally { for (const input of inputs) closeSync(input.fd); closeSync(directory); }
  }
}
if (import.meta.main) {
  try { prepareMaintenanceIndex(maintenanceOutputRoot()!, Number(process.argv[2])); console.log(JSON.stringify({ prepared: true })); }
  catch (error) { const code = (error as NodeJS.ErrnoException).code; console.error("Disposable index preparation refused: " + (code && /^[A-Z]{2,32}$/.test(code) ? code : "invalid")); process.exitCode = 1; }
}
