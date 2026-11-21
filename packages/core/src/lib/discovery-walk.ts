/** A visible-file walk that prunes a directory before reading any of its entries. */
import { readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

/** Latin-1 preserves every filename byte while retaining Dirents on Bun
 * 1.4.4 (encoding: buffer returns bare Buffers there). Decode only names
 * whose UTF-8 round-trip is exact; never reopen a replacement-character alias.
 */
function readDiscoveryDirectory(path: string): Dirent[] {
  return readdirSync(path, { withFileTypes: true, encoding: "latin1" }).flatMap(entry => {
    const raw = Buffer.from(entry.name, "latin1"), name = raw.toString("utf8");
    return Buffer.from(name).equals(raw) ? [Object.assign(entry, { name })] : [];
  });
}

export function* discoveryFiles(root: string, excludedDirectory: (path: string) => boolean,
  read: (path: string) => Dirent[] = readDiscoveryDirectory): Generator<string> {
  function* walk(prefix: string): Generator<string> {
    for (const entry of read(join(root, prefix))) {
      if (entry.name.startsWith(".")) continue;
      const path = prefix + entry.name;
      if (entry.isDirectory()) {
        if (!excludedDirectory(path)) yield* walk(`${path}/`);
      } else if (entry.isFile()) yield path;
    }
  }
  yield* walk("");
}
