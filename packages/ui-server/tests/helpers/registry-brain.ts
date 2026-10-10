import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Real catalog-only brain; no runtime turn or provider request is started. */
export function registryBrainFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "brain-registry-")));
  // The documented external-state identity is a hash of the canonical brain.
  const key = createHash("sha256").update(root).digest("hex");
  return {
    root,
    cleanup() {
      rmSync(join(homedir(), ".local/state/brain-kit/pi", key), { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}
