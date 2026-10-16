/** Read provenance the installed SDK omits from its normalized history API. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { transcriptPaths } from "./transcript-archive.js";
import { directory, isSessionId, regular } from "./worker-state.js";

export function taskNotificationMessages(brainPath: string, sessionId: string,
  env?: Record<string, string | undefined>): Map<string, string> {
  const notices = new Map<string, string>();
  if (!isSessionId(sessionId)) return notices;
  const { live } = transcriptPaths(brainPath, env), path = join(live, `${sessionId}.jsonl`);
  if (!existsSync(path)) return notices;
  directory(live);
  // This is the same authoritative native transcript the SDK reads. Keep its
  // chain selection; enrich only UUIDs whose message bytes still agree. No
  // XML matching: a human can legitimately submit a complete notification.
  for (const line of regular(path, Infinity).toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type === "user" && typeof entry.uuid === "string" && entry.origin?.kind === "task-notification")
      notices.set(entry.uuid, JSON.stringify(entry.message));
  }
  return notices;
}
