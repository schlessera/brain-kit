/** Metadata fence shared with Settings' single live-policy interpretation. No cache. */
import { lstatSync } from "node:fs";
import { join } from "node:path";
export function trustPolicyGeneration(root: string): string {
  return [root, join(root, "context"), join(root, "context/policies"), join(root, "context/policies/governance.md")].map((path, index) => {
    try {
      const info = lstatSync(path, { bigint: true });
      return [info.dev, info.ino, info.mode, info.nlink, ...(index === 3 ? [info.size, info.mtimeNs, info.ctimeNs] : [])].map(String).join(":");
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
  }).join("|");
}
