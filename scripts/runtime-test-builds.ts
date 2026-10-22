/** Fixed runtime consumers; this table never narrows Bun's test discovery. */
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export const runtimeTestBuilds: Readonly<Record<string, readonly string[]>> = Object.fromEntries([
  "answer-delivery", "approval-recovery", "artifact-recovery", "association-signout", "auth-expiry", "chat-focus",
  "connection-continuity", "draft", "external-speech", "html-preview", "local-work", "parallel-sessions", "scratch-links", "tracker", "turn-journal",
].map(name => [`packages/ui-react/tests/${name}-runtime.test.ts`, ["ui-react", "ui-server", "core"]]));
const special: Readonly<Record<string, readonly string[]>> = {
  "packages/ui-react/tests/haiku-model-runtime.test.ts": ["ui-react"],
  "packages/ui-react/tests/share-draft-runtime.test.ts": ["ui-sdk"],
};
export const runtimeBuildInventory = { ...runtimeTestBuilds, ...special };

/** Paths are already parsed by the wrapper's value-aware Bun argument parser. */
export function runtimeBuildSelection(root: string, cwd: string, paths: readonly string[]): string[] {
  const selected = new Set<string>();
  for (const [file, packages] of Object.entries(runtimeBuildInventory)) {
    if (!existsSync(join(root, file))) continue;
    const absolute = join(root, file);
    if (paths.some(path => {
      if (isAbsolute(path) || path.startsWith(".")) {
        const target = resolve(cwd, path);
        return absolute === target || absolute.startsWith(`${target}/`);
      }
      return absolute.includes(path);
    })) for (const pkg of packages) selected.add(pkg);
  }
  return [...selected];
}
