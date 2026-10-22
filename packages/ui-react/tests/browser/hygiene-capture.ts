import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Keep the local review path and retain the same bytes outside container scratch. */
export async function hygieneCapture(name: string, capture: (path: string) => Promise<Uint8Array>): Promise<string> {
  if (!/^[a-z0-9-]+\.png$/.test(name)) throw new Error("Invalid hygiene capture name");
  const path = resolve(tmpdir(), name);
  const bytes = await capture(path);
  const base = resolve("../../tmp/hygiene-proof");
  mkdirSync(base, { recursive: true });
  // Separate captures cannot overwrite earlier evidence, including across files.
  const directory = mkdtempSync(join(base, "capture-"));
  writeFileSync(join(directory, name), bytes);
  return path;
}
