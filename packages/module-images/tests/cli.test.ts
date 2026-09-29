// `brain image` end to end with `fetch` stubbed (#586): what the command
// decides, what it actually sends, and what it reports. Nothing leaves the
// process — the OpenAI key is a placeholder and every request is captured.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildTaxonomy } from "@schlessera/brain";

import { imageCommand } from "../src/cli";
import { configSchema } from "../src/module";

const SUNBURST = "gpt-image-2.5-sunburst";
const FLARE = "gpt-image-2.5-flare";
const PNG_B64 = Buffer.from("fake-png-bytes").toString("base64");

let root: string;
let out: string[];
let calls: { url: string; init: RequestInit }[];
const saved = {
  openai: process.env.OPENAI_API_KEY,
  gemini: process.env.GEMINI_API_KEY,
  log: console.log,
  error: console.error,
  fetch: globalThis.fetch,
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "brain-image-cli-"));
  mkdirSync(join(root, "photos"));
  writeFileSync(join(root, "photos", "house.png"), new Uint8Array([1, 2, 3]));
  writeFileSync(join(root, "photos", "mask.png"), new Uint8Array([4, 5, 6]));
  process.env.OPENAI_API_KEY = "placeholder-never-sent";
  delete process.env.GEMINI_API_KEY;
  out = [];
  console.log = (line: string) => void out.push(line);
  console.error = (line: string) => void out.push(line);
  calls = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), {
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  console.log = saved.log;
  console.error = saved.error;
  globalThis.fetch = saved.fetch;
  for (const [name, value] of [["OPENAI_API_KEY", saved.openai], ["GEMINI_API_KEY", saved.gemini]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const run = (argv: string[], config: Record<string, unknown> = {}) =>
  imageCommand.run(argv, {
    root,
    json: true,
    config: configSchema.parse(config),
    taxonomy: buildTaxonomy({}),
  } as never);

/** The last JSON document printed. */
const report = () => JSON.parse(out[out.length - 1]);
const sentJson = () => JSON.parse(calls[0].init.body as string);

describe("brain image — default and explicit model", () => {
  test("an unpinned request sends Sunburst and reports Sunburst", async () => {
    expect(await run(["a heat pump", "--out", "a.png"])).toBe(0);
    expect(calls).toHaveLength(1);
    expect(sentJson().model).toBe(SUNBURST);
    expect(report()).toMatchObject({ model: SUNBURST, provider: "openai", costUsd: null });
  });

  test("--model Flare with transparency, webp and max quality reaches the payload unchanged", async () => {
    const code = await run([
      "a logo", "--model", FLARE, "--transparent", "--format", "webp", "--quality", "max", "--out", "logo.webp",
    ]);
    expect(code).toBe(0);
    expect(sentJson()).toMatchObject({ model: FLARE, background: "transparent", output_format: "webp", quality: "max" });
    expect(report().model).toBe(FLARE);
  });

  test("a masked, transparent edit goes to Sunburst over multipart with background and xhigh", async () => {
    const code = await run([
      "replace the sky", "--ref", "photos/house.png", "--mask", "photos/mask.png",
      "--transparent", "--quality", "xhigh", "--out", "edit.png",
    ]);
    expect(code).toBe(0);
    expect(calls[0].url).toEndWith("/images/edits");
    const form = calls[0].init.body as FormData;
    expect(form.get("model")).toBe(SUNBURST);
    expect(form.get("background")).toBe("transparent");
    expect(form.get("quality")).toBe("xhigh");
    expect(form.get("mask")).toBeInstanceOf(Blob);
  });

  test("a configured Flare preference holds for a transparent request", async () => {
    expect(await run(["a logo", "--transparent", "--out", "l.png"], { preferredModels: [FLARE] })).toBe(0);
    expect(sentJson()).toMatchObject({ model: FLARE, background: "transparent" });
  });
});

describe("brain image — refused before the provider is called", () => {
  for (const retired of ["gpt-image-2", "gpt-image-1.5"]) {
    test(`--model ${retired} gets a migration error`, async () => {
      expect(await run(["x", "--model", retired])).toBe(1);
      expect(calls).toHaveLength(0);
      const said = out.join("\n");
      expect(said).toMatch(/retired/);
      expect(said).toContain(SUNBURST);
      expect(said).toContain(FLARE);
    });

    for (const key of ["preferredModels", "disabledModels"]) {
      test(`${retired} in ${key} gets a migration error naming the key`, async () => {
        expect(await run(["x"], { [key]: [retired] })).toBe(1);
        expect(calls).toHaveLength(0);
        expect(out.join("\n")).toContain(key);
      });
    }
  }

  test("a transparent JPEG", async () => {
    expect(await run(["x", "--transparent", "--format", "jpeg"])).toBe(1);
    expect(calls).toHaveLength(0);
    expect(out.join("\n")).toMatch(/alpha/);
  });

  test("an unknown quality", async () => {
    expect(await run(["x", "--quality", "ultra"])).toBe(1);
    expect(calls).toHaveLength(0);
    expect(out.join("\n")).toContain("xhigh");
  });

  test("an unknown format", async () => {
    expect(await run(["x", "--format", "gif"])).toBe(1);
    expect(calls).toHaveLength(0);
  });

  test("an off-grid custom size", async () => {
    expect(await run(["x", "--size", "1234x768"])).toBe(1);
    expect(calls).toHaveLength(0);
  });

  for (const size of ["big", "1024x", "1024x768px"]) {
    test(`a size that is not WIDTHxHEIGHT (${size})`, async () => {
      expect(await run(["x", "--size", size])).toBe(1);
      expect(calls).toHaveLength(0);
      expect(out.join("\n")).toContain("WIDTHxHEIGHT");
    });
  }

  test("OpenAI disabled entirely leaves transparency impossible, not rerouted", async () => {
    expect(await run(["x", "--transparent"], { disabledModels: [SUNBURST, FLARE] })).toBe(1);
    expect(calls).toHaveLength(0);
  });
});

describe("brain image — what it reports without spending", () => {
  test("a dry run names Sunburst and an unknown cost, in the same envelope", async () => {
    expect(await run(["x", "--dry-run", "--transparent"])).toBe(0);
    expect(calls).toHaveLength(0);
    const r = report();
    expect(Object.keys(r).sort()).toEqual(["estimatedCostUsd", "model", "output", "provider", "reason", "status"]);
    expect(r).toMatchObject({ status: "dry-run", model: SUNBURST, estimatedCostUsd: null });
  });

  test("a dry run with a stated quality and size is priced by the 2.5 calculator", async () => {
    expect(await run(["x", "--dry-run", "--quality", "low", "--size", "1024x1024"])).toBe(0);
    expect(calls).toHaveLength(0);
    // 196 output tokens at $30/M: the guide's own worked example.
    expect(report().estimatedCostUsd).toBeCloseTo(0.00588, 10);

    out.length = 0;
    expect(await run(["x", "--dry-run", "--model", FLARE, "--quality", "max", "--aspect", "3:2"])).toBe(0);
    // 3:2 at 1K becomes 1248x832: 96 on the long edge, 64 on the short, 4667 tokens.
    expect(report()).toMatchObject({ model: FLARE });
    expect(report().estimatedCostUsd).toBeCloseTo(0.14001, 10);
  });

  test("a dry run with auto quality or no size stays unpriced", async () => {
    for (const argv of [["--quality", "auto", "--size", "1024x1024"], ["--quality", "high"], ["--size", "1024x1024"]]) {
      out.length = 0;
      expect(await run(["x", "--dry-run", ...argv])).toBe(0);
      expect(report().estimatedCostUsd).toBeNull();
    }
    expect(calls).toHaveLength(0);
  });

  test("`models` lists both 2.5 models with no borrowed price, and no retired model", async () => {
    expect(await run(["models"])).toBe(0);
    const rows = report().models as { model: string; approxCostUsd1K: number | null }[];
    expect(rows.map((r) => r.model)).toEqual([SUNBURST, FLARE]);
    for (const r of rows) expect(r.approxCostUsd1K).toBeNull();
  });
});
