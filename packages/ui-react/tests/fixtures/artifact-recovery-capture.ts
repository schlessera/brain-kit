import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

/** Keep fixture review captures while retaining their bytes after fixture cleanup. */
export async function artifactRecoveryCapture(path: string, capture: (path: string) => Promise<Uint8Array>): Promise<void> {
  const bytes = await capture(path);
  const base = resolve(import.meta.dir, "../../.vitest-attachments/artifact-recovery");
  await mkdir(base, { recursive: true });
  // Repeated names cannot overwrite earlier evidence, including across runs.
  const directory = await mkdtemp(join(base, "capture-"));
  await writeFile(join(directory, basename(path)), bytes);
}
