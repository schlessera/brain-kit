/** A visible-file walk that prunes a directory before reading any of its entries. */
import { readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

export function* discoveryFiles(root: string, excludedDirectory: (path: string) => boolean,
  read: (path: string) => Dirent[] = path => readdirSync(path, { withFileTypes: true })): Generator<string> {
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
