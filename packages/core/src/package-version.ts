import { readFileSync } from "fs";
import { fileURLToPath } from "url";

export function packageVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf-8")
  ) as { version: string };
  return manifest.version;
}

/** The core package's directory: where its package.json lives. */
export function packageRoot(): string {
  return fileURLToPath(new URL("..", import.meta.url));
}
