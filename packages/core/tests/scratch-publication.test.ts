import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { WriteRefusedError } from "../src/lib/safe-path.js";
import { SCRATCH_DIR, ensureScratch, isWriteRefusal, writeScratchFile } from "../src/lib/scratch.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function scratchRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "brain-scratch-publication-")));
  roots.push(root);
  const init = Bun.spawnSync(["git", "init", "-q", root], { stderr: "pipe" });
  expect(init.exitCode).toBe(0);
  fs.writeFileSync(join(root, ".gitignore"), `${SCRATCH_DIR}/\n`);
  ensureScratch(root);
  return root;
}

describe("scratch nonreplacement publication", () => {
  test("preserves an arriving destination's nonempty bytes before reporting refusal", () => {
    const root = scratchRoot();
    const target = join(root, SCRATCH_DIR, "race.bin");
    const competingBytes = Buffer.from("concurrent writer owns these bytes\n");
    const original = fs.lstatSync;
    let targetReads = 0;
    const spy = spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike, options?: { throwIfNoEntry?: boolean }) => {
      const result = original(path, options as never);
      if (String(path) === target && ++targetReads === 2) {
        expect(result).toBeUndefined();
        fs.writeFileSync(target, competingBytes, { flag: "wx" });
      }
      return result;
    }) as typeof fs.lstatSync);
    let failure: unknown;
    try { writeScratchFile(root, target, "replacement bytes", { replace: false }); }
    catch (error) { failure = error; }
    finally { spy.mockRestore(); }

    // Byte preservation comes first: a refusal assertion must not mask data loss.
    expect(fs.readFileSync(target)).toEqual(competingBytes);
    expect(targetReads).toBe(2);
    expect(competingBytes.byteLength).toBeGreaterThan(0);
    expect(failure).toBeInstanceOf(WriteRefusedError);
    expect(isWriteRefusal(failure)).toBe(true);
    expect(fs.readdirSync(join(root, SCRATCH_DIR))).toEqual(["race.bin"]);
  });

  for (const kind of ["file", "symlink", "dangling symlink", "directory"] as const) {
    for (const arriving of [false, true]) {
      test(`preserves an ${arriving ? "arriving" : "existing"} ${kind} and another writer's sibling`, () => {
        const root = scratchRoot();
        const directory = join(root, SCRATCH_DIR);
        const target = join(directory, "occupied.bin");
        const other = join(root, "other.bin");
        const pending = join(directory, ".other-writer.tmp");
        const bytes = Buffer.from("another writer's nonempty bytes\n");
        fs.writeFileSync(other, bytes);
        fs.writeFileSync(pending, bytes);
        const pendingInode = fs.lstatSync(pending).ino;
        let targetInode = 0;
        let targetMode = 0;
        const createEntry = () => {
          if (kind === "file") fs.writeFileSync(target, bytes, { flag: "wx" });
          else if (kind === "directory") {
            fs.mkdirSync(target);
            fs.writeFileSync(join(target, "keep.bin"), bytes);
          } else fs.symlinkSync(kind === "symlink" ? other : join(root, "absent.bin"), target);
          const entry = fs.lstatSync(target);
          targetInode = entry.ino;
          targetMode = entry.mode;
        };
        if (!arriving) createEntry();
        const original = fs.lstatSync;
        let targetReads = 0;
        const spy = spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike, options?: { throwIfNoEntry?: boolean }) => {
          const result = original(path, options as never);
          if (String(path) === target && ++targetReads === 2 && arriving) {
            expect(result).toBeUndefined();
            createEntry();
          }
          return result;
        }) as typeof fs.lstatSync);
        let failure: unknown;
        try { writeScratchFile(root, target, "replacement bytes", { replace: false }); }
        catch (error) { failure = error; }
        finally { spy.mockRestore(); }

        if (kind === "file") expect(fs.readFileSync(target)).toEqual(bytes);
        else if (kind === "directory") expect(fs.readFileSync(join(target, "keep.bin"))).toEqual(bytes);
        else expect(fs.readlinkSync(target)).toBe(kind === "symlink" ? other : join(root, "absent.bin"));
        expect(targetInode).toBeGreaterThan(0);
        expect(fs.lstatSync(target).ino).toBe(targetInode);
        expect(fs.lstatSync(target).mode).toBe(targetMode);
        expect(fs.readFileSync(other)).toEqual(bytes);
        expect(fs.readFileSync(pending)).toEqual(bytes);
        expect(fs.lstatSync(pending).ino).toBe(pendingInode);
        expect(isWriteRefusal(failure)).toBe(true);
        if (arriving) expect(failure).toBeInstanceOf(WriteRefusedError);
        expect(fs.readdirSync(directory).sort()).toEqual([".other-writer.tmp", "occupied.bin"]);
      });
    }
  }

  test("publishes complete binary bytes with the default mode and removes its temporary link", () => {
    const root = scratchRoot();
    const target = join(root, SCRATCH_DIR, "complete.bin");
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(writeScratchFile(root, target, bytes, { replace: false })).toBe(target);
    expect(fs.readFileSync(target)).toEqual(Buffer.from(bytes));
    expect(fs.statSync(target).mode & 0o777).toBe(0o666 & ~process.umask());
    expect(fs.statSync(target).nlink).toBe(1);
    expect(fs.readdirSync(join(root, SCRATCH_DIR))).toEqual(["complete.bin"]);
  });

  for (const mode of [0o600, 0o640, 0o444]) {
    test(`replacement preserves mode ${mode.toString(8)} without writing through another hard link`, () => {
      const root = scratchRoot();
      const target = join(root, SCRATCH_DIR, "replacement.bin");
      const other = join(root, "shared.bin");
      fs.writeFileSync(other, "original bytes");
      fs.chmodSync(other, mode);
      fs.linkSync(other, target);
      const originalInode = fs.statSync(other).ino;
      writeScratchFile(root, target, "replacement bytes", { replace: true });
      expect(fs.readFileSync(target, "utf8")).toBe("replacement bytes");
      expect(fs.readFileSync(other, "utf8")).toBe("original bytes");
      expect(fs.statSync(other).ino).toBe(originalInode);
      expect(fs.statSync(target).ino).not.toBe(originalInode);
      expect(fs.statSync(target).mode & 0o777).toBe(mode);
      expect(fs.statSync(other).mode & 0o777).toBe(mode);
      expect(fs.readdirSync(join(root, SCRATCH_DIR))).toEqual(["replacement.bin"]);
    });
  }

  for (const code of ["EACCES", "EPERM", "EOPNOTSUPP"]) {
    test(`propagates ${code} and cleans only its owned temporary sibling`, () => {
      const root = scratchRoot();
      const directory = join(root, SCRATCH_DIR);
      const target = join(directory, "failure.bin");
      const pending = join(directory, ".another-writer.tmp");
      const bytes = Buffer.from("preserve this writer's nonempty bytes\n");
      fs.writeFileSync(pending, bytes);
      const expected = Object.assign(new Error(`fixture ${code}`), { code });
      let temporary = "";
      const spy = spyOn(fs, "linkSync").mockImplementation((from, to) => {
        expect(String(to)).toBe(target);
        temporary = String(from);
        fs.writeFileSync(target, bytes, { flag: "wx" });
        throw expected;
      });
      let failure: unknown;
      try { writeScratchFile(root, target, "replacement bytes", { replace: false }); }
      catch (error) { failure = error; }
      finally { spy.mockRestore(); }
      expect(fs.readFileSync(target)).toEqual(bytes);
      expect(fs.readFileSync(pending)).toEqual(bytes);
      expect(temporary).not.toBe("");
      expect(fs.existsSync(temporary)).toBe(false);
      expect(failure).toBe(expected);
      expect(isWriteRefusal(failure)).toBe(false);
      expect(fs.readdirSync(directory).sort()).toEqual([".another-writer.tmp", "failure.bin"]);
    });
  }

  test("never removes a temporary name occupied before this writer acquires it", () => {
    const root = scratchRoot();
    const directory = join(root, SCRATCH_DIR);
    const target = join(directory, "collision.bin");
    const bytes = Buffer.from("this temporary entry belongs to another writer\n");
    const original = fs.openSync;
    let borrowed = "";
    const spy = spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
      if (String(path).startsWith(`${directory}/.`) && String(path).endsWith(".tmp") && flags === "wx") {
        borrowed = String(path);
        const fd = original(path, "wx", 0o600);
        try { fs.writeSync(fd, bytes); }
        finally { fs.closeSync(fd); }
      }
      return original(path, flags, mode);
    }) as typeof fs.openSync);
    let failure: unknown;
    try { writeScratchFile(root, target, "replacement bytes", { replace: false }); }
    catch (error) { failure = error; }
    finally { spy.mockRestore(); }
    expect(borrowed).not.toBe("");
    expect(fs.readFileSync(borrowed)).toEqual(bytes);
    expect(fs.existsSync(target)).toBe(false);
    expect((failure as NodeJS.ErrnoException).code).toBe("EEXIST");
    expect(isWriteRefusal(failure)).toBe(false);
    expect(fs.readdirSync(directory)).toEqual([borrowed.split("/").pop()!]);
  });

  test("does not clean through a parent redirected after exclusive publication", () => {
    const root = scratchRoot();
    const parent = join(root, SCRATCH_DIR, "nested");
    const moved = join(root, SCRATCH_DIR, "original-directory");
    const outside = join(root, "outside-scratch");
    const target = join(parent, "output.bin");
    fs.mkdirSync(parent);
    fs.mkdirSync(outside);
    const original = fs.linkSync;
    const bytes = Buffer.from("the redirected directory's temporary entry\n");
    let foreign = "";
    const spy = spyOn(fs, "linkSync").mockImplementation((from, to) => {
      original(from, to);
      const temporaryName = String(from).split("/").pop()!;
      fs.renameSync(parent, moved);
      foreign = join(outside, temporaryName);
      fs.writeFileSync(foreign, bytes);
      fs.symlinkSync(outside, parent);
    });
    let failure: unknown;
    try { writeScratchFile(root, target, "complete output bytes", { replace: false }); }
    catch (error) { failure = error; }
    finally { spy.mockRestore(); }
    expect(foreign).not.toBe("");
    expect(fs.existsSync(foreign)).toBe(true);
    expect(fs.readFileSync(foreign)).toEqual(bytes);
    expect(isWriteRefusal(failure)).toBe(true);
    expect(fs.lstatSync(parent).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(join(moved, "output.bin"), "utf8")).toBe("complete output bytes");
    expect(fs.readdirSync(moved)).toHaveLength(2);
    expect(fs.existsSync(join(outside, "output.bin"))).toBe(false);
  });
});
