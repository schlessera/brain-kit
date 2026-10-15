/** Bounded process-lifetime witness inside the fixed offline native container. */
import { readFileSync, readdirSync, readlinkSync, writeFileSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";

export function observeIndexDescendants(directory: string, options: { retainMountNamespace?: boolean } = {}) {
  type Row = { pid: number; start: string; firstWallAt: number; lastLiveWallAt: number; deadObservedWallAt?: number; cwd: string; mountNamespace: string; ancestry: string[] };
  const records = new Map<string, Row>();
  let truncated = false;
  let pinned: { fd: number; pid: number; namespace: string; openedWallAt: number; closedWallAt?: number; closedReason?: string } | undefined;
  function unpin(reason: string) { if (pinned && !pinned.closedWallAt) { closeSync(pinned.fd); pinned.closedWallAt = Date.now(); pinned.closedReason = reason; } }
  function live(pid: number, start: string) {
    try { const fields = readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "").split(" "); return fields[0] !== "Z" && fields[19] === start; } catch { return false; }
  }
  function sample() {
    const at = Date.now();
    for (const row of records.values()) if (!row.deadObservedWallAt) {
      if (live(row.pid, row.start)) row.lastLiveWallAt = at; else row.deadObservedWallAt = at;
    }
    const names = readdirSync("/proc").filter(name => /^\d+$/.test(name));
    truncated ||= names.length > 256;
    for (const name of names.slice(0, 256)) try {
      if (readFileSync(`/proc/${name}/comm`, "utf8").trim() !== "odysseus-index") continue;
      const fields = readFileSync(`/proc/${name}/stat`, "utf8").replace(/^.*\) /s, "").split(" "), start = fields[19]!;
      if (fields[0] === "Z" || records.has(`${name}:${start}`)) continue;
      if (records.size >= 16) { truncated = true; continue; }
      const ancestry: string[] = []; let parent = Number(fields[1]);
      for (let i = 0; parent > 0 && i < 8; i++) {
        const stat = readFileSync(`/proc/${parent}/stat`, "utf8"); ancestry.push(stat.slice(0, 1024));
        parent = Number(stat.replace(/^.*\) /s, "").split(" ")[1]);
      }
      if (options.retainMountNamespace && !pinned) pinned = { fd: openSync(`/proc/${name}/ns/mnt`, "r"), pid: Number(name), namespace: readlinkSync(`/proc/${name}/ns/mnt`), openedWallAt: Date.now() };
      records.set(`${name}:${start}`, { pid: Number(name), start, firstWallAt: at, lastLiveWallAt: at,
        cwd: readlinkSync(`/proc/${name}/cwd`).slice(0, 4096), mountNamespace: readlinkSync(`/proc/${name}/ns/mnt`), ancestry });
    } catch { /* A short-lived process may disappear during this fixed census. */ }
  }
  const timer = setInterval(sample, 50);
  return {
    releaseNamespace() { unpin("native-sync-failed"); },
    result() { sample(); return { records: [...records.values()], truncated, pinned }; },
    close() { clearInterval(timer); const result = this.result(); unpin("fixture-close"); writeFileSync(join(directory, "index-descendant-lifetime.json"), JSON.stringify(result, null, 2)); },
  };
}
