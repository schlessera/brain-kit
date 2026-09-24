// `brain image --scratch` (#310): a draft goes to the brain's scratch area,
// and only once git ignores it. `--dry-run` decides the path and stops before
// any provider call, so a placeholder key routes and no request is made; the
// write tests stub `fetch` with a Gemini-shaped reply, so no request leaves
// either.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildTaxonomy, ignoreScratch, SCRATCH_DIR, SCRATCH_TTL_MS } from "@schlessera/brain";

import { imageCommand } from "../src/cli";
import { configSchema } from "../src/module";

let root: string;
const saved = { key: process.env.GEMINI_API_KEY, log: console.log, error: console.error, fetch: globalThis.fetch };
let out: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "brain-image-scratch-"));
  Bun.spawnSync(["git", "-C", root, "init", "-q"]);
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  process.env.GEMINI_API_KEY = "placeholder-never-sent";
  out = [];
  console.log = (line: string) => void out.push(line);
  console.error = (line: string) => void out.push(line);
});

afterEach(() => {
  console.log = saved.log;
  console.error = saved.error;
  globalThis.fetch = saved.fetch;
  if (saved.key === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = saved.key;
  rmSync(root, { recursive: true, force: true });
});

const run = (argv: string[]) =>
  imageCommand.run(argv, { root, json: true, config: configSchema.parse({}), taxonomy: buildTaxonomy({}) } as never);

const PNG_BYTES = "fake-png-bytes";

/** A provider that answers every call with one PNG, after running `before`. */
function stubProvider(before: () => void = () => {}): { calls: number } {
  const state = { calls: 0 };
  globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) => {
    state.calls++;
    before();
    return new Response(
      JSON.stringify({
        status: "completed",
        output_image: { data: Buffer.from(PNG_BYTES).toString("base64"), mime_type: "image/png" },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return state;
}

const scratchFiles = () => (existsSync(join(root, SCRATCH_DIR)) ? readdirSync(join(root, SCRATCH_DIR)) : []);

describe("brain image --scratch", () => {
  test("refuses while scratch is not gitignored, naming the fix", async () => {
    expect(await run(["a lighthouse", "--draft", "--scratch", "--dry-run"])).toBe(1);
    expect(out.join("\n")).toContain("brain doctor --fix");
  });

  test("once ignored, the draft goes to .brain/scratch/ under a name of its own", async () => {
    ignoreScratch(root);
    expect(await run(["a lighthouse", "--draft", "--scratch", "--dry-run"])).toBe(0);
    const payload = JSON.parse(out.join("\n")) as { output: string };
    expect(payload.output).toMatch(/^\.brain\/scratch\/a-lighthouse-\d{8}T\d{9}Z-[0-9a-f]{6}\.[a-z]+$/);
  });

  test("--out and --scratch together are refused", async () => {
    expect(await run(["a lighthouse", "--scratch", "--out", "assets/x.png", "--dry-run"])).toBe(1);
    expect(out.join("\n")).toContain("exclusive");
  });

  test("the bytes the provider returned land in scratch, and the write prunes it", async () => {
    ignoreScratch(root);
    mkdirSync(join(root, SCRATCH_DIR), { recursive: true });
    const stale = join(root, SCRATCH_DIR, "stale.png");
    writeFileSync(stale, "old");
    const t = (Date.now() - SCRATCH_TTL_MS - 60_000) / 1000;
    utimesSync(stale, t, t);
    const provider = stubProvider();
    expect(await run(["a lighthouse", "--draft", "--scratch"])).toBe(0);
    expect(provider.calls).toBe(1);
    const payload = JSON.parse(out.join("\n")) as { output: string; bytes: number };
    expect(payload.output).toMatch(/^\.brain\/scratch\/a-lighthouse-.*\.png$/);
    expect(readFileSync(join(root, payload.output), "utf8")).toBe(PNG_BYTES);
    expect(payload.bytes).toBe(PNG_BYTES.length);
    expect(existsSync(stale)).toBe(false);
    expect(scratchFiles()).toHaveLength(1);
  });

  test("two drafts of one prompt keep both files", async () => {
    ignoreScratch(root);
    stubProvider();
    expect(await run(["a lighthouse", "--draft", "--scratch"])).toBe(0);
    expect(await run(["a lighthouse", "--draft", "--scratch"])).toBe(0);
    expect(scratchFiles()).toHaveLength(2);
  });

  test("a planted symlink at the corrected name is refused, and the outside file is byte-identical", async () => {
    ignoreScratch(root);
    // --out asks for .jpeg; the provider answers PNG, so the write goes to
    // draft.png, where a link to an outside file has been planted.
    const outside = mkdtempSync(join(tmpdir(), "brain-outside-"));
    const victim = join(outside, "victim.png");
    writeFileSync(victim, "keep me");
    mkdirSync(join(root, SCRATCH_DIR), { recursive: true });
    symlinkSync(victim, join(root, SCRATCH_DIR, "draft.png"));
    stubProvider();
    expect(await run(["a lighthouse", "--draft", "--out", `${SCRATCH_DIR}/draft.jpeg`])).toBe(1);
    expect(out.join("\n")).toContain("symlink");
    expect(readFileSync(victim, "utf8")).toBe("keep me");
    expect(readlinkSync(join(root, SCRATCH_DIR, "draft.png"))).toBe(victim);
    expect(scratchFiles()).toEqual(["draft.png"]);
    rmSync(outside, { recursive: true, force: true });
  });

  test("a nested directory swapped for a symlink while the request is out is refused, and nothing lands outside", async () => {
    ignoreScratch(root);
    const outside = mkdtempSync(join(tmpdir(), "brain-outside-"));
    const nested = join(root, SCRATCH_DIR, "nested");
    stubProvider(() => {
      rmSync(nested, { recursive: true, force: true });
      symlinkSync(outside, nested);
    });
    expect(await run(["a lighthouse", "--draft", "--out", `${SCRATCH_DIR}/nested/draft.png`])).toBe(1);
    expect(readdirSync(outside)).toEqual([]);
    rmSync(outside, { recursive: true, force: true });
  });

  test("the ignore rule is checked again after the provider call, so a rule lost in flight refuses the write", async () => {
    ignoreScratch(root);
    // The rule disappears while the request is out: the pre-flight check
    // passed, the write must not.
    stubProvider(() => writeFileSync(join(root, ".gitignore"), "node_modules\n"));
    expect(await run(["a lighthouse", "--draft", "--scratch"])).toBe(1);
    expect(out.join("\n")).toContain("brain doctor --fix");
    expect(scratchFiles()).toEqual([]);
  });
});
