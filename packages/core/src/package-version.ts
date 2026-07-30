import { readFileSync } from "fs";

export function packageVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf-8")
  ) as { version: string };
  return manifest.version;
}
