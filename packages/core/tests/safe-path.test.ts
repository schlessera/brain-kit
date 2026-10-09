import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import * as fs from "fs";
import { resolveWritable, safeResolve, WriteRefusedError, writeFileSafely } from "../src/lib/safe-path";

const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "brain-kit-safe-path-"));
  fixtures.push(dir);
  return dir;
}

describe("safeResolve", () => {
  test("resolves a contained relative path", () => {
    const root = makeRoot();
    mkdirSync(join(root, "notes"));
    writeFileSync(join(root, "notes/a.md"), "x");
    expect(safeResolve(root, "notes/a.md")).toBe(realpathSync(join(root, "notes/a.md")));
  });

  test("allows a not-yet-existing file under an existing real directory", () => {
    const root = makeRoot();
    mkdirSync(join(root, "notes"));
    const out = safeResolve(root, "notes/new.md");
    expect(out).toBe(join(realpathSync(root), "notes/new.md"));
  });

  test("allows a not-yet-existing nested directory chain", () => {
    const root = makeRoot();
    const out = safeResolve(root, "a/b/c/new.md");
    expect(out).toBe(join(realpathSync(root), "a/b/c/new.md"));
  });

  test("rejects .. escapes and absolute paths", () => {
    const root = makeRoot();
    expect(safeResolve(root, "../outside.md")).toBeNull();
    expect(safeResolve(root, "notes/../../outside.md")).toBeNull();
    expect(safeResolve(root, "/etc/passwd")).toBeNull();
  });

  test("rejects sibling-prefix paths", () => {
    const root = makeRoot();
    // /tmp/xxx vs /tmp/xxx-other: bare startsWith(root) would accept this.
    const sibling = root + "-other";
    mkdirSync(sibling);
    fixtures.push(sibling);
    expect(safeResolve(root, join("..", `${root.split("/").pop()}-other`, "x.md"))).toBeNull();
  });

  test("rejects an existing symlink that points outside the root", () => {
    const root = makeRoot();
    const outside = makeRoot();
    writeFileSync(join(outside, "secret.md"), "s");
    symlinkSync(join(outside, "secret.md"), join(root, "link.md"));
    expect(safeResolve(root, "link.md")).toBeNull();
  });

  test("rejects a NOT-yet-existing file under a symlinked parent that escapes the root", () => {
    const root = makeRoot();
    const outside = makeRoot();
    symlinkSync(outside, join(root, "sneaky"));
    // The target file does not exist, so the old lexical fallback would have
    // accepted this path — while the write would land in `outside`.
    expect(safeResolve(root, "sneaky/new.md")).toBeNull();
    expect(safeResolve(root, "sneaky/deep/new.md")).toBeNull();
  });

  test("allows a symlinked parent that stays inside the root", () => {
    const root = makeRoot();
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "alias"));
    const out = safeResolve(root, "alias/new.md");
    expect(out).toBe(join(realpathSync(root), "real/new.md"));
  });
});

describe("safeResolve — dangling and cyclic symlinks", () => {
  test("rejects a dangling symlink whose target would land outside the root", () => {
    const root = makeRoot();
    const outside = makeRoot();
    // Link exists, target does NOT — a write through it would be created at
    // the target. The old lexical fallback accepted this.
    symlinkSync(join(outside, "pwned.md"), join(root, "link.md"));
    expect(safeResolve(root, "link.md")).toBeNull();
    // Same with a dangling DIRECTORY link as a middle component.
    symlinkSync(join(outside, "no-such-dir"), join(root, "sneakydir"));
    expect(safeResolve(root, "sneakydir/new.md")).toBeNull();
  });

  test("accepts a dangling symlink whose target stays inside the root", () => {
    const root = makeRoot();
    symlinkSync(join(root, "not-yet.md"), join(root, "link.md"));
    expect(safeResolve(root, "link.md")).toBe(join(realpathSync(root), "not-yet.md"));
  });

  test("rejects a dangling symlink cycle instead of looping", () => {
    const root = makeRoot();
    symlinkSync(join(root, "b"), join(root, "a"));
    symlinkSync(join(root, "a"), join(root, "b"));
    expect(safeResolve(root, "a/x.md")).toBeNull();
  });

  test("returns null for a missing root and NUL bytes", () => {
    const root = makeRoot();
    expect(safeResolve(join(root, "does-not-exist"), "x.md")).toBeNull();
    expect(safeResolve(root, "a\0b.md")).toBeNull();
  });
});

describe("resolveWritable", () => {
  const root = mkdtempSync(join(tmpdir(), "brain-writable-"));

  test("a repo-relative path resolves inside the repo", () => {
    const r = resolveWritable(root, "notes/x.md");
    expect(r?.startsWith(realpathSync(root))).toBe(true);
  });

  test("the scratch area is inside the repo, so it resolves", () => {
    expect(resolveWritable(root, ".brain/scratch/x.pdf")).toBe(join(realpathSync(root), ".brain/scratch/x.pdf"));
  });

  test("a path under the system temp directory but outside the brain is refused (#310)", () => {
    // Output there could not be opened from the UI; transient output goes to
    // the brain's scratch area instead.
    const target = join(tmpdir(), "scratch", "x.html");
    expect(target.startsWith(realpathSync(root))).toBe(false);
    expect(resolveWritable(root, target)).toBeNull();
  });

  test("anywhere else outside the brain is refused", () => {
    for (const bad of ["/etc/passwd", "/etc/cron.d/x", "/root/.ssh/authorized_keys"]) {
      expect(resolveWritable(root, bad)).toBeNull();
    }
  });

  test("a NUL byte is refused", () => {
    expect(resolveWritable(root, "\0/etc/passwd")).toBeNull();
  });
});

describe("writeFileSafely", () => {
  const root = mkdtempSync(join(tmpdir(), "brain-write-safely-"));
  fixtures.push(root);
  const mode = (p: string) => fs.statSync(p).mode & 0o7777;

  test("a replaced regular file keeps its exact mode; a new file gets the default", () => {
    const secret = join(root, "secret.txt");
    fs.writeFileSync(secret, "old", { mode: 0o600 });
    fs.chmodSync(secret, 0o600);
    writeFileSafely(secret, "new");
    expect(fs.readFileSync(secret, "utf8")).toBe("new");
    expect(mode(secret)).toBe(0o600);
    const fresh = join(root, "fresh.txt");
    writeFileSafely(fresh, "x");
    expect(mode(fresh)).toBe(0o666 & ~process.umask());
    expect(fs.readdirSync(root).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("a write that fails part way leaves the target whole and no temporary sibling (#1355)", () => {
    const directory = makeRoot(), target = join(directory, "ithaca.md");
    fs.writeFileSync(target, "Odysseus's original log");
    const original = fs.writeSync;
    let partial = false;
    // The first chunk lands, then the disk fills: the way a full disk fails a write.
    const spy = spyOn(fs, "writeSync").mockImplementation(((fd: number, buffer: Uint8Array, offset = 0, length = buffer.byteLength - offset) => {
      if (partial) throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
      partial = true;
      return original(fd, buffer, offset, Math.min(length, 4));
    }) as typeof fs.writeSync);
    let error: unknown;
    try { writeFileSafely(target, "a replacement longer than four bytes"); }
    catch (caught) { error = caught; }
    finally { spy.mockRestore(); }
    expect(partial).toBe(true);
    expect((error as NodeJS.ErrnoException).code).toBe("ENOSPC");
    expect(fs.readFileSync(target, "utf8")).toBe("Odysseus's original log");
    expect(fs.readdirSync(directory)).toEqual(["ithaca.md"]);
  });

  test("beforePublish runs after staging and a throw from it abandons the write", () => {
    const directory = makeRoot(), target = join(directory, "ithaca.md");
    fs.writeFileSync(target, "before");
    let staged: string[] = [];
    expect(() => writeFileSafely(target, "after", {
      beforePublish: () => {
        staged = fs.readdirSync(directory).filter((f) => f.endsWith(".tmp"));
        throw new Error("changed meanwhile");
      },
    })).toThrow("changed meanwhile");
    expect(fs.readFileSync(target, "utf8")).toBe("before");
    expect(fs.readdirSync(directory)).toEqual(["ithaca.md"]);
    expect(staged.length).toBe(1);
  });

  test("mode sets the written file's exact bits, past the umask", () => {
    const directory = makeRoot(), target = join(directory, "archive.md");
    const bits = 0o666 & ~process.umask() ^ 0o020; // differs from the default either way
    writeFileSafely(target, "archived", { replace: false, mode: bits });
    expect(mode(target)).toBe(bits);
    expect(mode(target)).not.toBe(0o666 & ~process.umask());
  });

  test("an existing name under replace:false is refused with code EEXIST", () => {
    const directory = makeRoot(), target = join(directory, "ithaca.md");
    fs.writeFileSync(target, "taken");
    let error: unknown;
    try { writeFileSafely(target, "x", { replace: false }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(WriteRefusedError);
    expect((error as WriteRefusedError).code).toBe("EEXIST");
  });

  test("a symlink at the name is a refusal by design, typed as one", () => {
    fs.writeFileSync(join(root, "target.txt"), "keep me");
    fs.symlinkSync("target.txt", join(root, "link.txt"));
    expect(() => writeFileSafely(join(root, "link.txt"), "x")).toThrow(WriteRefusedError);
    expect(fs.readFileSync(join(root, "target.txt"), "utf8")).toBe("keep me");
  });

  test("replace:false preserves a file arriving after the final absence check and refuses publication", () => {
    const directory = makeRoot(), target = join(directory, "ithaca.md");
    const arriving = Buffer.from("Odysseus keeps the concurrent writer's bytes");
    const original = fs.lstatSync;
    let checks = 0, injected = false, error: unknown;
    const spy = spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike, options?: { throwIfNoEntry?: boolean }) => {
      const entry = original(path, options);
      if (String(path) === target && !entry && ++checks === 2) {
        fs.writeFileSync(target, arriving, { mode: 0o600 });
        injected = true;
      }
      return entry;
    }) as typeof fs.lstatSync);
    try { writeFileSafely(target, "replacement bytes", { replace: false }); }
    catch (caught) { error = caught; }
    finally { spy.mockRestore(); }
    // Inspect the competing writer's real bytes before any refusal assertion.
    expect(fs.readFileSync(target)).toEqual(arriving);
    expect(injected).toBe(true);
    expect(checks).toBe(2);
    expect(error).toBeInstanceOf(WriteRefusedError);
    expect((error as Error).message).toContain("EEXIST");
    expect(mode(target)).toBe(0o600);
    expect(fs.readdirSync(directory)).toEqual(["ithaca.md"]);
  });

  test("replace:false publishes complete binary bytes with the default mode and no temporary sibling", () => {
    const directory = makeRoot(), target = join(directory, "ithaca.bin");
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    writeFileSafely(target, bytes, { replace: false });
    expect(fs.readFileSync(target)).toEqual(Buffer.from(bytes));
    expect(mode(target)).toBe(0o666 & ~process.umask());
    expect(fs.statSync(target).nlink).toBe(1);
    expect(fs.readdirSync(directory)).toEqual(["ithaca.bin"]);
  });

  for (const replace of [false, true]) {
    for (const kind of ["file", "symlink", "dangling symlink", "directory"] as const) {
      if (replace && kind === "file") continue;
      test(`replace:${replace} refuses an existing ${kind} without altering its entry`, () => {
        const directory = makeRoot(), target = join(directory, "ithaca.md"), other = join(directory, "odysseus.md");
        fs.writeFileSync(other, "Odysseus keeps these bytes");
        if (kind === "file") fs.writeFileSync(target, "existing bytes");
        else if (kind === "directory") fs.mkdirSync(target);
        else fs.symlinkSync(kind === "symlink" ? other : join(directory, "absent.md"), target);
        const before = fs.lstatSync(target);
        let error: unknown;
        try { writeFileSafely(target, "replacement bytes", { replace }); }
        catch (caught) { error = caught; }
        expect(fs.lstatSync(target).ino).toBe(before.ino);
        expect(fs.readFileSync(other, "utf8")).toBe("Odysseus keeps these bytes");
        if (kind === "file") expect(fs.readFileSync(target, "utf8")).toBe("existing bytes");
        if (kind === "directory") expect(fs.readdirSync(target)).toEqual([]);
        if (kind.includes("symlink")) expect(fs.readlinkSync(target)).toBe(kind === "symlink" ? other : join(directory, "absent.md"));
        expect(error).toBeInstanceOf(WriteRefusedError);
        expect(fs.readdirSync(directory).sort()).toEqual(["ithaca.md", "odysseus.md"]);
      });
    }
  }

  test("replace:true replaces the entry atomically without changing another hard link's bytes or mode", () => {
    const directory = makeRoot(), target = join(directory, "ithaca.md"), other = join(directory, "odysseus.md");
    fs.writeFileSync(other, "original bytes", { mode: 0o600 });
    fs.chmodSync(other, 0o600);
    fs.linkSync(other, target);
    const before = fs.statSync(other);
    writeFileSafely(target, "replacement bytes", { replace: true });
    expect(fs.readFileSync(target, "utf8")).toBe("replacement bytes");
    expect(fs.readFileSync(other, "utf8")).toBe("original bytes");
    expect(fs.statSync(other).ino).toBe(before.ino);
    expect(fs.statSync(target).ino).not.toBe(before.ino);
    expect(mode(target)).toBe(0o600);
    expect(mode(other)).toBe(0o600);
    expect(fs.readdirSync(directory).sort()).toEqual(["ithaca.md", "odysseus.md"]);
  });


  for (const kind of ["symlink", "dangling symlink", "directory"] as const) {
    test(`replace:false preserves an arriving ${kind} and cleans only its temporary sibling`, () => {
      const directory = makeRoot(), target = join(directory, "ithaca.md"), other = join(directory, "odysseus.md");
      fs.writeFileSync(other, "Odysseus keeps these bytes");
      const original = fs.lstatSync;
      let checks = 0, injected = false, error: unknown;
      const spy = spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike, options?: { throwIfNoEntry?: boolean }) => {
        const entry = original(path, options);
        if (String(path) === target && !entry && ++checks === 2) {
          if (kind === "directory") fs.mkdirSync(target);
          else fs.symlinkSync(kind === "symlink" ? other : join(directory, "absent.md"), target);
          injected = true;
        }
        return entry;
      }) as typeof fs.lstatSync);
      try { writeFileSafely(target, "replacement bytes", { replace: false }); }
      catch (caught) { error = caught; }
      finally { spy.mockRestore(); }
      expect(fs.readFileSync(other, "utf8")).toBe("Odysseus keeps these bytes");
      if (kind === "directory") expect(fs.lstatSync(target).isDirectory()).toBe(true);
      else expect(fs.readlinkSync(target)).toBe(kind === "symlink" ? other : join(directory, "absent.md"));
      expect(injected).toBe(true);
      expect(checks).toBe(2);
      expect(error).toBeInstanceOf(WriteRefusedError);
      expect((error as Error).message).toContain("EEXIST");
      expect(fs.readdirSync(directory).sort()).toEqual(["ithaca.md", "odysseus.md"]);
    });
  }

  for (const code of ["EACCES", "EPERM"]) {
    test(`an ${code} publication failure propagates and removes only this writer's temporary sibling`, () => {
      const directory = makeRoot(), target = join(directory, "ithaca.md");
      const arriving = Buffer.from("Odysseus keeps the concurrent writer's bytes");
      const failure = Object.assign(new Error(`fixture ${code}`), { code });
      let temporary = "", error: unknown;
      const spy = spyOn(fs, "linkSync").mockImplementation((from, to) => {
        temporary = String(from);
        if (String(to) !== target) throw new Error("unexpected publication target");
        fs.writeFileSync(target, arriving);
        throw failure;
      });
      try { writeFileSafely(target, "replacement bytes", { replace: false }); }
      catch (caught) { error = caught; }
      finally { spy.mockRestore(); }
      expect(fs.readFileSync(target)).toEqual(arriving);
      expect(error).toBe(failure);
      expect(error).not.toBeInstanceOf(WriteRefusedError);
      expect(temporary).not.toBe("");
      expect(fs.existsSync(temporary)).toBe(false);
      expect(fs.readdirSync(directory)).toEqual(["ithaca.md"]);
    });
  }

});
