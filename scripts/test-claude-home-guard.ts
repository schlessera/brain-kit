/** Process-local write-attempt guard: other sessions may use their own home. */
import { spyOn } from "bun:test";
import * as fs from "node:fs";
import * as promises from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function installClaudeHomeGuard(home: string, config?: string) {
  const roots = [resolve(home, ".claude"), ...(config ? [resolve(config)] : [])];
  const canonical = (path: string): string => {
    try { return fs.realpathSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(path);
      return parent === path ? path : resolve(canonical(parent), basename(path));
    }
  };
  const protectedRoots = roots.flatMap(path => [path, canonical(path)]);
  let attempted = false;
  const check = (input: unknown) => {
    if (typeof input === "number") return; // Writable opens are guarded below.
    const path = input instanceof URL ? fileURLToPath(input)
      : Buffer.isBuffer(input) ? input.toString() : typeof input === "string" ? input : undefined;
    if (path === undefined) return;
    const absolute = resolve(path);
    const matches = (candidate: string) => protectedRoots.some(root => candidate === root || candidate.startsWith(root + sep));
    if (matches(absolute) || matches(canonical(absolute))) {
      attempted = true;
      throw new Error("TEST_WROTE_INVOKING_CLAUDE_HOME: test attempted to write invoking Claude storage");
    }
  };
  const spies: Array<{ mockRestore(): void }> = [];
  const mutators: Record<string, number[]> = {
    appendFile: [0], chmod: [0], chown: [0], copyFile: [1], cp: [1],
    lchmod: [0], lchown: [0], lutimes: [0], link: [1], mkdir: [0], mkdtemp: [0],
    rename: [0, 1], rm: [0], rmdir: [0], symlink: [1], truncate: [0], unlink: [0], utimes: [0], writeFile: [0],
  };
  const wrap = (target: object, name: string, indices: number[], asynchronous = false, opening = false) => {
    const methods = target as Record<string, (...args: unknown[]) => unknown>;
    if (typeof methods[name] !== "function") return;
    const original = methods[name]!;
    const invoke = (...args: unknown[]) => {
      const flags = args[1];
      const writable = !opening || (typeof flags === "number"
        ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0
        : typeof flags === "string" && /[wa+]/.test(flags));
      if (writable) for (const index of indices) check(args[index]);
      return Reflect.apply(original, target, args);
    };
    spies.push(spyOn(methods, name).mockImplementation(asynchronous ? async (...args) => invoke(...args) : invoke));
  };
  for (const [name, indices] of Object.entries(mutators)) {
    wrap(fs, name, indices);
    wrap(fs, name + "Sync", indices);
    wrap(promises, name, indices, true);
  }
  wrap(fs, "open", [0], false, true);
  wrap(fs, "openSync", [0], false, true);
  wrap(promises, "open", [0], true, true);
  wrap(fs, "createWriteStream", [0]);
  const write = Bun.write;
  const guardedWrite = ((...args: unknown[]) => {
    const destination = args[0];
    check(typeof destination === "object" && destination !== null && "name" in destination ? destination.name : destination);
    return Reflect.apply(write, Bun, args);
  }) as typeof Bun.write;
  spies.push(spyOn(Bun, "write").mockImplementation(guardedWrite));
  const filePrototype = Object.getPrototypeOf(Bun.file(import.meta.path)) as Record<string, (...args: unknown[]) => unknown>;
  for (const name of ["write", "writer", "unlink", "delete"]) {
    const native = filePrototype[name]!;
    spies.push(spyOn(filePrototype, name).mockImplementation(function (this: { name?: string }, ...args: unknown[]) {
      check(this.name);
      return Reflect.apply(native, this, args);
    }));
  }
  return {
    assertNoEscapes() {
      if (attempted) throw new Error("TEST_WROTE_INVOKING_CLAUDE_HOME: a test attempted to write invoking Claude storage");
    },
    dispose() { for (const spy of spies.reverse()) spy.mockRestore(); },
  };
}
