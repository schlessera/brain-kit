/** A visible-file walk that prunes a directory before reading any of its entries. */
import { readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

type UnrepresentableName = (path: string, directory: boolean) => void;

/** Latin-1 preserves every filename byte while retaining Dirents on Bun
 * 1.4.4 (encoding: buffer returns bare Buffers there). Decode only names
 * whose UTF-8 round-trip is exact; never reopen a replacement-character alias.
 */
function readDiscoveryDirectory(path: string, onUnrepresentable?: UnrepresentableName): Dirent[] {
  return readdirSync(path, { withFileTypes: true, encoding: "latin1" }).flatMap(entry => {
    const raw = Buffer.from(entry.name, "latin1"), name = raw.toString("utf8");
    if (Buffer.from(name).equals(raw)) return [Object.assign(entry, { name })];
    if (!name.startsWith(".") && (entry.isDirectory() || entry.isFile())) onUnrepresentable?.(name, entry.isDirectory());
    return [];
  });
}

/** Indexer scans may skip unrepresentable names: they index readable paths.
 * Reference inventories must supply onUnrepresentable and refuse an unknown
 * note or directory, since silently skipping it could hide a media reference.
 */
export function* discoveryFiles(root: string, excludedDirectory: (path: string) => boolean,
  read: (path: string, onUnrepresentable?: UnrepresentableName) => Dirent[] = readDiscoveryDirectory,
  onUnrepresentable?: UnrepresentableName): Generator<string> {
  function* walk(prefix: string): Generator<string> {
    for (const entry of read(join(root, prefix), (name, directory) => {
      const path = prefix + name;
      if (!directory || !excludedDirectory(path)) onUnrepresentable?.(path, directory);
    })) {
      if (entry.name.startsWith(".")) continue;
      const path = prefix + entry.name;
      if (entry.isDirectory()) {
        if (!excludedDirectory(path)) yield* walk(`${path}/`);
      } else if (entry.isFile()) yield path;
    }
  }
  yield* walk("");
}
