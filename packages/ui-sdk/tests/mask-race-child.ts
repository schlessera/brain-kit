/** Isolated syscall controls: mock only the FS boundary and the keyless ignore-policy answer. */
import { mock, test } from "bun:test";
import * as fs from "fs";
import { basename, dirname, join, sep } from "node:path";
import { tmpdir } from "node:os";

const real = { ...fs };
const root = real.mkdtempSync(join(tmpdir(), "odysseus-mask-race-"));
const brain = join(root, "brain");
const scratch = join(brain, ".brain", "scratch");
const nested = join(scratch, "nested");
const outside = join(root, "outside");
const stage = process.env.MASK_RACE_STAGE!;
const writer = process.env.MASK_RACE_WRITER!;
const expectedOutside: Record<string, string> = { "x-mask.png": "outside mask stays" };
const outsideOperations: string[] = [];
const outsideMaskFds = new Set<number>();
let injected = false;
let forcedRenameFailure = false;
let nestedFd: number | undefined;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
if (stage === "nonlinux-refusal" || stage === "nonlinux-ordinary") Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
real.mkdirSync(nested, { recursive: true });
real.mkdirSync(join(brain, ".git"));
real.mkdirSync(outside);
real.writeFileSync(join(outside, "x-mask.png"), expectedOutside["x-mask.png"]!);
if (stage === "ignore-mkdir") real.rmSync(scratch, { recursive: true });

function swap(tmp?: string) {
  if (injected) return;
  injected = true;
  const dir = stage === "ignore-mkdir" ? join(brain, ".brain") : nested;
  real.renameSync(dir, dir + "-kept");
  real.symlinkSync(outside, dir);
  if (tmp) {
    const name = basename(tmp);
    expectedOutside[name] = "outside tmp stays";
    real.writeFileSync(join(outside, name), expectedOutside[name]!);
  }
}
const temp = (path: fs.PathLike) => /^\.(?:x-mask\.png|scratch)\..*\.tmp$/.test(basename(String(path)));
mock.module("fs", () => ({ ...real,
  openSync(path: fs.PathLike, flags: string | number, mode?: fs.Mode) {
    if ((stage === "temp-open" || stage === "nonlinux-refusal") && temp(path)) swap();
    if (stage === "directory-open" && basename(String(path)) === "nested") swap();
    const fd = real.openSync(path, flags, mode);
    if (basename(String(path)) === "nested") nestedFd = fd;
    if (temp(path)) {
      const opened = real.readlinkSync(`/proc/self/fd/${fd}`);
      if (opened.startsWith(outside + sep)) { outsideOperations.push("temporary open"); outsideMaskFds.add(fd); }
      if (writer === "scratch" && !opened.startsWith(scratch + sep)) { outsideOperations.push("scratch boundary temporary open"); outsideMaskFds.add(fd); }
    }
    return fd;
  },
  fstatSync(fd: number) {
    if (stage === "stat-error" && fd === nestedFd) {
      injected = true;
      throw Object.assign(new Error("fixture descriptor stat failure"), { code: "EIO" });
    }
    return real.fstatSync(fd);
  },
  writeSync(...args: unknown[]) {
    if (stage === "write-error") {
      injected = true;
      throw Object.assign(new Error("fixture write failure"), { code: "ENOSPC" });
    }
    const written = Reflect.apply(real.writeSync, undefined, args) as number;
    if (outsideMaskFds.has(Number(args[0])) && written > 0) {
      const offset = Number(args[2] ?? 0);
      outsideOperations.push(`written bytes ${Buffer.from(args[1] as Uint8Array).subarray(offset, offset + written).toString("hex")}`);
    }
    return written;
  },
  mkdirSync(path: fs.PathLike, options?: fs.MakeDirectoryOptions) {
    if (stage === "mkdir" && basename(String(path)) === "new") swap();
    if (stage === "ignore-mkdir" && basename(String(path)) === "scratch") swap();
    try { if (real.realpathSync(dirname(String(path))).startsWith(outside)) outsideOperations.push("mkdir"); } catch {}
    return real.mkdirSync(path, options);
  },
  renameSync(from: fs.PathLike, to: fs.PathLike) {
    if (temp(from)) {
      if (stage === "rename") swap(String(from));
      if (stage === "cleanup" && !forcedRenameFailure) {
        forcedRenameFailure = true;
        throw Object.assign(new Error("fixture rename failure"), { code: "EIO" });
      }
    }
    try { if (real.realpathSync(dirname(String(to))).startsWith(outside)) outsideOperations.push("rename"); } catch {}
    return real.renameSync(from, to);
  },
  rmSync(path: fs.PathLike, options?: fs.RmOptions) {
    if (stage === "cleanup" && temp(path)) swap(String(path));
    try { if (real.realpathSync(dirname(String(path))).startsWith(outside)) outsideOperations.push("cleanup"); } catch {}
    return real.rmSync(path, options);
  },
}));
// The mask uses a server-owned maintenance worker to ask git about ignore
// policy. This control isolates filesystem races, so it supplies the fixture's
// known directory-ignore answer and never starts a runtime or network client.
mock.module(new URL("../src/server/maintenance-worker.ts", import.meta.url).pathname, () => ({ brainGitSync: () => 0 }));
test("isolated mask filesystem race control", async () => {
try {
  const masks = await import("../src/server/bridge-tools/mask.ts");
  const target = stage === "nonlinux-ordinary" ? join(brain, "assets", "x-mask.png")
    : stage === "scratch-root" ? scratch : stage === "scratch-traversal" ? `${scratch}/../x-mask.png`
    : join(nested, (stage === "mkdir" || stage === "directory-open") ? "new" : "", "x-mask.png");
  const beforeDescriptors = real.readdirSync("/proc/self/fd").length;
  let error: string | null = null;
  try {
    if (writer === "scratch") masks.writeScratchMask(brain, target, new Uint8Array([11, 22, 33, 44]));
    else masks.writeMaskFile(target, new Uint8Array([11, 22, 33, 44]));
  } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
  const afterDescriptors = real.readdirSync("/proc/self/fd").length;
  const remainingTemps = real.existsSync(nested) && !real.lstatSync(nested).isSymbolicLink()
    ? real.readdirSync(nested).filter((name) => /^\.(?:x-mask\.png|scratch)\..*\.tmp$/.test(name)) : [];
  const savedBytes = stage === "nonlinux-ordinary" && real.existsSync(target) ? real.readFileSync(target).toString("hex") : null;
  const actualOutside = Object.fromEntries(real.readdirSync(outside).sort().map((name) => [name,
    real.lstatSync(join(outside, name)).isDirectory() ? "<directory>" : real.readFileSync(join(outside, name)).toString("hex")]));
  const expected = Object.fromEntries(Object.entries(expectedOutside).map(([name, content]) => [name, Buffer.from(content).toString("hex")]));
  console.log(JSON.stringify({ injected, error, beforeDescriptors, afterDescriptors, remainingTemps, savedBytes, outsideOperations, actualOutside, expectedOutside: expected }));
} finally { Object.defineProperty(process, "platform", platform); real.rmSync(root, { recursive: true, force: true }); }
});
