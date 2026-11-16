/**
 * Turn data trees on the managed volume (#2911): the manager's reader census
 * and removal program. A turn's tree lives under the manager's private
 * `trees/` directory, outside the live brain and every checkpoint, so a copy
 * from the turn's checkpoint into it shares that checkpoint's extents.
 */
import { isWithin } from "@schlessera/brain-common/internal/safe-path";
import { readdirSync, readFileSync } from "node:fs";

/**
 * Removes one tree with the standard library's descriptor-relative walk,
 * which never follows a link the app or a worker left inside it. It refuses
 * where that walk is unavailable, and a top-level path that is not a plain
 * directory.
 */
export const NATIVE_TREE_REMOVAL = `import os,sys,stat,shutil
if not shutil.rmtree.avoids_symlink_attacks: raise SystemExit("descriptor-relative removal is unavailable")
path=sys.argv[1]
try: info=os.lstat(path)
except FileNotFoundError: raise SystemExit(0)
if not stat.S_ISDIR(info.st_mode): raise SystemExit("turn tree is not a plain directory")
shutil.rmtree(path)
`;

const unescape = (text: string) => text.replace(/\\(040|011|012|134)/g, (_all, digits: string) => String.fromCharCode(parseInt(digits, 8)));
const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

/**
 * The processes whose mount namespace holds a mount of `root` (a path inside
 * the store filesystem `device`, as `major:minor`) or of anything under it: a
 * worker's read-only bind of its tree. A process that exits while it is read
 * is no reader; any other read failure is thrown, so the caller refuses
 * instead of treating an unknown as no reader.
 */
export function nativeTurnTreeReaders(device: string, root: string, proc = "/proc"): number[] {
  const readers: number[] = [];
  for (const name of readdirSync(proc)) {
    if (!/^[1-9][0-9]*$/.test(name)) continue;
    let text: string;
    // ESRCH and ENOENT: it exited. EINVAL: a zombie, which has no mount namespace.
    try { text = readFileSync(`${proc}/${name}/mountinfo`, "utf8"); } catch (error) { if (["ENOENT", "ESRCH", "EINVAL"].includes(code(error) ?? "")) continue; throw error; }
    for (const line of text.split("\n")) {
      const fields = line.split(" ");
      if (fields[2] === device && fields[3] !== undefined && isWithin(root, unescape(fields[3]))) { readers.push(Number(name)); break; }
    }
  }
  return readers;
}
