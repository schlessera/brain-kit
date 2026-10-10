/**
 * Fixture brain for `tests/tag-alias-writer.test.ts`. The case ("pylos-synonym")
 * was authored for the #844 tag-alias spike; only its data, the brain setup and
 * a byte-and-metadata snapshot of the tree are kept here.
 */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

/** `left` is used in two documents (one excluded); `right` is the vocabulary term. */
export const fixture = { id: "pylos-synonym", left: "council-record", right: "council-minutes",
  leftContext: "Nestor records the decisions and discussion of this council meeting.",
  rightContext: "Nestor writes down what the elders decided and argued at the council meeting." };

export function prepare() {
  const root = mkdtempSync(join(tmpdir(), "tag-alias-fixture-"));
  const paths = ["context/pylos/left.md", "context/pylos/right.md"] as const;
  const doc = (title: string, tag: string, body: string) => `---\ntype: context\ntitle: '${title}'\nstatus: active\ncreated: 2026-07-10\nupdated: 2026-07-12\ntags: [${tag}] # retain this comment\n---\n\n${body}\n`;
  const files: Record<string, string> = { [paths[0]]: doc("First usage", fixture.left, fixture.leftContext), [paths[1]]: doc("Second usage", fixture.right, fixture.rightContext),
    "excluded/kept.md": doc("Excluded usage", fixture.left, "This fictional excluded record remains unchanged.") };
  const config = { profile: { name: "Odysseus" }, exclude: { dirs: ["excluded"] },
    taxonomy: { types: { tablet: { dir: "tablets" } }, tags: { vocabulary: [fixture.right], aliases: { "old-vigil": "legacy-vigil" } as Record<string, string>, inflection: "off" } } };
  for (const [path, raw] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), raw); utimesSync(join(root, path), new Date("2026-07-12"), new Date("2026-07-12")); }
  writeFileSync(join(root, "brain.config.json"), JSON.stringify(config, null, 2) + "\n");
  writeFileSync(join(root, "sentinel.bin"), new Uint8Array([0, 255, 7]));
  return { root, fixture, paths, files, config, close() { rmSync(root, { recursive: true, force: true }); } };
}

/** Every entry under `root` with its mode, nanosecond mtime and bytes or link target. */
export function snapshot(root: string) {
  const entries: Record<string, { kind: string; mode: number; mtimeNs: string; bytes?: string; target?: string }> = {};
  function visit(path: string) {
    const full = join(root, path), stat = lstatSync(full, { bigint: true });
    const meta = { mode: Number(stat.mode & 0o7777n), mtimeNs: stat.mtimeNs.toString() };
    if (stat.isSymbolicLink()) entries[path] = { ...meta, kind: "symlink", target: readlinkSync(full) };
    else if (stat.isDirectory()) {
      entries[path] = { ...meta, kind: "directory" };
      for (const name of readdirSync(full).sort()) visit(path ? `${path}/${name}` : name);
    } else if (stat.isFile()) entries[path] = { ...meta, kind: "file", bytes: readFileSync(full).toString("base64") };
    else throw Error("Unsupported fixture entry");
  }
  for (const name of readdirSync(root).sort()) visit(name);
  return entries;
}
