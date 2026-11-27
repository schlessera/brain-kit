import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeChain, directoryChain, type ChainRefusal } from "../src/files/anchored-chain";

class Refused extends Error {
  constructor(readonly reason: ChainRefusal) { super(reason); }
}
const refuse = (reason: ChainRefusal) => new Refused(reason);

const roots: string[] = [];
afterEach(() => { mock.restore(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function brain(): string {
  const root = mkdtempSync(join(tmpdir(), "anchored-chain-ithaca-"));
  roots.push(root);
  return root;
}

/**
 * Every handle the chain opens, through the `open` it imports. A closed
 * handle reports `fd` -1, so a handle left open shows up here whatever else
 * the process is doing.
 */
function watchHandles(): { handles: fsp.FileHandle[]; open(): fsp.FileHandle[] } {
  const handles: fsp.FileHandle[] = [];
  const real = fsp.open;
  spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
    const handle = await real(...args);
    handles.push(handle);
    return handle;
  }) as typeof fsp.open);
  return { handles, open: () => handles.filter(handle => handle.fd !== -1) };
}

async function refusal(run: Promise<unknown>): Promise<unknown> {
  try { await run; } catch (error) { return error; }
  throw new Error("expected a refusal");
}

describe("directoryChain", () => {
  test("a symlink at the first component is refused and every handle closed", async () => {
    const root = brain(), outside = brain();
    symlinkSync(outside, join(root, "context"));
    const watched = watchHandles();
    const error = await refusal(directoryChain(root, "context/scheduled-tasks", true, refuse));
    expect(error).toBeInstanceOf(Refused);
    expect((error as Refused).reason).toBe("not-contained");
    expect(watched.handles.length).toBeGreaterThan(0);
    expect(watched.open()).toEqual([]);
    expect(readdirSync(outside)).toEqual([]);
  });

  test("a symlink at a middle component is refused and every handle closed", async () => {
    const root = brain(), outside = brain();
    mkdirSync(join(root, "context"));
    symlinkSync(outside, join(root, "context/scheduled-tasks"));
    const watched = watchHandles();
    const error = await refusal(directoryChain(root, "context/scheduled-tasks/definitions", true, refuse));
    expect((error as Refused).reason).toBe("not-contained");
    expect(watched.handles.length).toBeGreaterThan(0);
    expect(watched.open()).toEqual([]);
    expect(readdirSync(outside)).toEqual([]);
  });

  test("a regular file where a directory is expected is refused half-way with no handle left open", async () => {
    const root = brain();
    mkdirSync(join(root, "_voice"));
    writeFileSync(join(root, "_voice/personas"), "not a directory");
    const watched = watchHandles();
    const error = await refusal(directoryChain(root, "_voice/personas", false, refuse));
    expect((error as Refused).reason).toBe("not-contained");
    expect(watched.handles.length).toBeGreaterThan(0);
    expect(watched.open()).toEqual([]);
  });

  test("a missing component with create off returns null and closes what it opened", async () => {
    const root = brain();
    mkdirSync(join(root, "_voice"));
    const watched = watchHandles();
    expect(await directoryChain(root, "_voice/personas", false, refuse)).toBeNull();
    expect(watched.handles.length).toBeGreaterThan(0);
    expect(watched.open()).toEqual([]);
  });

  test("a missing component with create on is created mode 0o755", async () => {
    const root = brain();
    const umask = process.umask(0);
    try {
      const chain = await directoryChain(root, "context/scheduled-tasks", true, refuse);
      try {
        expect(chain!.map(entry => entry.path)).toEqual([root, join(root, "context"), join(root, "context/scheduled-tasks")]);
        expect(statSync(join(root, "context")).mode & 0o777).toBe(0o755);
        expect(statSync(join(root, "context/scheduled-tasks")).mode & 0o777).toBe(0o755);
      } finally { await closeChain(chain); }
    } finally { process.umask(umask); }
  });
});
