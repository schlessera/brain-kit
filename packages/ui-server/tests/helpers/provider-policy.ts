import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** A governance policy hiding `folders` from every recipient but `allow`; none hides nothing. */
export function writePolicy(brain: string, folders: readonly string[] | null, allow = ["anthropic"]): void {
  writeFileSync(join(brain, "context/policies/governance.md"), folders
    ? `---\nschema_version: 1\nproviders: [{ paths: [${folders.map(folder => `${folder}/**`).join(", ")}], allow: [${allow.join(", ")}] }]\n---\nOdysseus's own folders stay with their provider.\n`
    : "---\nschema_version: 1\n---\nOdysseus's brain has no provider rules yet.\n");
}
