/**
 * `brain render`'s write, in process (#310): the destination is classified
 * again at the moment of the write, after the renderer ran, and only a
 * refusal by design is a usage error.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { renderCommand } from "../src/cli/commands/render.js";
import { UsageError } from "../src/cli/io.js";
import * as puppeteer from "../src/providers/renderers/puppeteer.js";
import { SCRATCH_DIR } from "../src/lib/scratch.js";

let root: string;
const saved = { log: console.log };
const spies: { mockRestore(): void }[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "brain-render-write-"));
  Bun.spawnSync(["git", "-C", root, "init", "-q"]);
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(join(root, "notes", "trip.md"), "# Trip\n");
  mkdirSync(join(root, "assets"), { recursive: true });
  console.log = () => {};
});
afterEach(() => {
  console.log = saved.log;
  for (const spy of spies.splice(0)) spy.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

const cli = () => ({ brain: { root }, json: true }) as never;

/** A renderer that runs `during` while "rendering", then returns a few bytes. */
function fakeRenderer(during: () => void) {
  const spy = spyOn(puppeteer, "resolveDocumentRenderer").mockImplementation(async () => ({
    renderPdf: async () => {
      during();
      return Buffer.from("%PDF-fake");
    },
    renderPng: async () => Buffer.from([1]),
    shutdown: async () => {},
  }));
  spies.push(spy);
}

describe("the write classifies its destination again after the renderer ran", () => {
  test("a directory that came to resolve into unignored scratch while rendering is refused, and scratch stays empty", async () => {
    mkdirSync(join(root, SCRATCH_DIR), { recursive: true });
    fakeRenderer(() => {
      rmSync(join(root, "assets"), { recursive: true, force: true });
      symlinkSync(join(".brain", "scratch"), join(root, "assets"));
    });
    await expect(renderCommand.run(["notes/trip.md", "--format", "pdf", "--out", "assets/result.pdf"], cli())).rejects.toThrow(
      UsageError,
    );
    expect(readdirSync(join(root, SCRATCH_DIR))).toEqual([]);
  });

  test("otherwise the render lands where it was asked to", async () => {
    fakeRenderer(() => {});
    await renderCommand.run(["notes/trip.md", "--format", "pdf", "--out", "assets/result.pdf"], cli());
    expect(existsSync(join(root, "assets", "result.pdf"))).toBe(true);
  });
});

describe("what kind of error a failed write is", () => {
  test("a refusal by design is a usage error: a --out that is a symlink", async () => {
    writeFileSync(join(root, "assets", "other.html"), "keep me");
    symlinkSync("other.html", join(root, "assets", "out.html"));
    await expect(renderCommand.run(["notes/trip.md", "--format", "html", "--out", "assets/out.html"], cli())).rejects.toThrow(
      UsageError,
    );
  });

  test("a filesystem failure is not: ENOSPC propagates as the internal error it is", async () => {
    const spy = spyOn(fs, "writeSync").mockImplementation(() => {
      const e = new Error("ENOSPC: no space left on device, write") as NodeJS.ErrnoException;
      e.code = "ENOSPC";
      throw e;
    });
    spies.push(spy);
    const run = renderCommand.run(["notes/trip.md", "--format", "html", "--out", "assets/out.html"], cli());
    await expect(run).rejects.toMatchObject({ code: "ENOSPC" });
    await expect(run).rejects.not.toBeInstanceOf(UsageError);
    expect(existsSync(join(root, "assets", "out.html"))).toBe(false);
  });
});
