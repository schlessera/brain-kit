// `brain image` end to end with `fetch` stubbed (#586): what the command
// decides, what it actually sends, and what it reports. Nothing leaves the
// process — the OpenAI key is a placeholder and every request is captured.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildTaxonomy } from "@schlessera/brain/module";

import { imageCommand } from "../src/cli";
import { configSchema } from "../src/module";

const SUNBURST = "gpt-image-2.6-sunburst";
const FLARE = "gpt-image-2.6-flare";
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
    expect(await run(["x", "--format", "tiff"])).toBe(1);
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
    const openai = ["gpt-image-2.6-sunburst", "gpt-image-2.6-flare", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare"];
    expect(await run(["x", "--transparent"], { disabledModels: openai })).toBe(1);
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
    for (const argv of [["--quality", "auto", "--size", "1024x1024"], ["--quality", "high"], []]) {
      out.length = 0;
      expect(await run(["x", "--dry-run", ...argv])).toBe(0);
      expect(report().estimatedCostUsd).toBeNull();
    }
    expect(calls).toHaveLength(0);
  });

  test("`models` lists the 2.6 and 2.5 models with no borrowed price, and no retired model", async () => {
    expect(await run(["models"])).toBe(0);
    const rows = report().models as { model: string; approxCostUsd1K: number | null }[];
    expect(rows.map((r) => r.model)).toEqual([SUNBURST, FLARE, "gpt-image-2.5-sunburst", "gpt-image-2.5-flare"]);
    for (const r of rows) expect(r.approxCostUsd1K).toBeNull();
  });
});

describe("brain image — keys withheld from an agent worker (#1666)", () => {
  test("with no image key, each withheld provider is named and nothing is sent", async () => {
    delete process.env.OPENAI_API_KEY;
    const previous = process.env.BRAIN_WITHHELD_KEYS;
    process.env.BRAIN_WITHHELD_KEYS = "GEMINI_API_KEY,OPENAI_API_KEY";
    try {
      expect(await run(["a harbour at dawn", "--out", "h.png"])).toBe(1);
      expect(calls).toHaveLength(0);
      expect(out.join("\n"), "IMAGE_NAMES_WITHHELD_PROVIDERS").toBe([
        "openai image unavailable: the host withholds OPENAI_API_KEY from agent workers [provider_unavailable provider=openai capability=image key=OPENAI_API_KEY degraded_to=none]",
        "gemini image unavailable: the host withholds GEMINI_API_KEY from agent workers [provider_unavailable provider=gemini capability=image key=GEMINI_API_KEY degraded_to=none]",
      ].join("\n"));
    } finally {
      if (previous === undefined) delete process.env.BRAIN_WITHHELD_KEYS; else process.env.BRAIN_WITHHELD_KEYS = previous;
    }
  });

  test("a pinned provider whose key is withheld is named while another provider stays available", async () => {
    const previous = process.env.BRAIN_WITHHELD_KEYS;
    process.env.BRAIN_WITHHELD_KEYS = "GEMINI_API_KEY";
    try {
      expect(await run(["a harbour at dawn", "--provider", "gemini", "--out", "h.png"])).toBe(1);
      expect(calls).toHaveLength(0);
      expect(out.join("\n"), "IMAGE_NAMES_PINNED_WITHHELD_PROVIDER").toContain(
        "[provider_unavailable provider=gemini capability=image key=GEMINI_API_KEY degraded_to=none]");
    } finally {
      if (previous === undefined) delete process.env.BRAIN_WITHHELD_KEYS; else process.env.BRAIN_WITHHELD_KEYS = previous;
    }
  });

  test("a keyless brain outside a worker keeps its ordinary refusal", async () => {
    delete process.env.OPENAI_API_KEY;
    expect(await run(["a harbour at dawn", "--out", "h.png"])).toBe(1);
    expect(out.join("\n")).toStartWith("No image provider is configured.");
  });
});

// GPT Image 2.6 (#3782): the default model, and the highest quality and
// complexity unless the request states otherwise.
describe("brain image — GPT Image 2.6 defaults (#3782)", () => {
  const SUNBURST_26 = "gpt-image-2.6-sunburst";
  const FLARE_26 = "gpt-image-2.6-flare";
  const SUNBURST_25 = "gpt-image-2.5-sunburst";
  const FLARE_25 = "gpt-image-2.5-flare";

  test("an unpinned generation sends 2.6 Sunburst at max quality and high complexity", async () => {
    expect(await run(["a heat pump", "--out", "a.png"])).toBe(0);
    expect(calls).toHaveLength(1);
    expect(sentJson(), "IMAGE_26_DEFAULTS_GENERATION").toMatchObject({
      model: SUNBURST_26, quality: "max", complexity: "high",
    });
    expect(report()).toMatchObject({ model: SUNBURST_26 });
  });

  test("an unpinned edit carries the same defaults over multipart", async () => {
    expect(await run(["repaint the door", "--ref", "photos/house.png", "--out", "e.png"])).toBe(0);
    expect(calls[0].url).toEndWith("/images/edits");
    const form = calls[0].init.body as FormData;
    expect(form.get("model")).toBe(SUNBURST_26);
    expect(form.get("quality"), "IMAGE_26_DEFAULTS_EDIT").toBe("max");
    expect(form.get("complexity")).toBe("high");
  });

  test("an explicit quality and complexity are sent as given, auto included", async () => {
    expect(await run(["x", "--model", FLARE_26, "--quality", "low", "--complexity", "medium", "--out", "x.png"])).toBe(0);
    expect(sentJson()).toMatchObject({ model: FLARE_26, quality: "low", complexity: "medium" });
    calls.length = 0;
    expect(await run(["x", "--quality", "auto", "--out", "y.png"])).toBe(0);
    expect(sentJson().quality).toBe("auto");
  });

  for (const model of [SUNBURST_25, FLARE_25]) {
    test(`${model} stays selectable, defaults to max and never receives complexity`, async () => {
      expect(await run(["x", "--model", model, "--out", "x.png"])).toBe(0);
      const body = sentJson();
      expect(body).toMatchObject({ model, quality: "max" });
      expect(body, "IMAGE_25_NO_COMPLEXITY").not.toHaveProperty("complexity");
    });

    test(`--complexity on ${model} refuses before any request`, async () => {
      expect(await run(["x", "--model", model, "--complexity", "low"])).toBe(1);
      expect(calls, "IMAGE_COMPLEXITY_GUARD").toHaveLength(0);
      expect(out.join("\n")).toContain(SUNBURST_26);
    });
  }

  test("--complexity on Gemini refuses before any request", async () => {
    process.env.GEMINI_API_KEY = "placeholder-never-sent";
    expect(await run(["x", "--provider", "gemini", "--complexity", "high"])).toBe(1);
    expect(calls).toHaveLength(0);
    expect(out.join("\n")).toMatch(/complexity/);
  });

  test("an unknown complexity refuses before routing", async () => {
    expect(await run(["x", "--complexity", "max"])).toBe(1);
    expect(calls).toHaveLength(0);
    expect(out.join("\n")).toContain("low, medium, high");
  });

  test("a dry run prices the defaulted max quality", async () => {
    expect(await run(["x", "--dry-run", "--aspect", "1:1"])).toBe(0);
    expect(calls).toHaveLength(0);
    // 1:1 at 1K is 1024x1024: 96 tokens a side at max, 7024 tokens at $30/M.
    expect(report()).toMatchObject({ model: SUNBURST_26 });
    expect(report().estimatedCostUsd, "IMAGE_26_DRY_RUN_MAX").toBeCloseTo(0.21072, 10);
  });

  test("`models` lists the 2.6 pair first, then the 2.5 pair", async () => {
    expect(await run(["models"])).toBe(0);
    expect((report().models as { model: string }[]).map((r) => r.model)).toEqual([
      SUNBURST_26, FLARE_26, SUNBURST_25, FLARE_25,
    ]);
  });

  test("the retired-model message names the 2.6 replacements", async () => {
    expect(await run(["x", "--model", "gpt-image-2"])).toBe(1);
    expect(out.join("\n")).toContain(SUNBURST_26);
    expect(out.join("\n")).toContain(FLARE_26);
  });
});

describe("brain image — animated GIF on GPT Image 2.6 (#3783)", () => {
  const SUNBURST_25 = "gpt-image-2.5-sunburst";

  test("--format gif sends the GIF fields and the 2.6 defaults, and writes a .gif", async () => {
    expect(await run(["a waving flag", "--format", "gif", "--frames", "12", "--frame-duration", "150", "--out", "flag.gif"])).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toEndWith("/images/generations");
    expect(sentJson(), "IMAGE_GIF_GENERATION").toMatchObject({
      model: SUNBURST, output_format: "gif", frame_count: 12, frame_duration_ms: 150, quality: "max", complexity: "high",
    });
    expect(report().output).toBe("flag.gif");
    expect(report().renamed).toBeNull();
  });

  test("the default output path ends in .gif", async () => {
    expect(await run(["a waving flag", "--format", "gif"])).toBe(0);
    expect(report().output).toEndWith(".gif");
  });

  test("omitted frame flags leave the API's own defaults in charge", async () => {
    expect(await run(["a waving flag", "--format", "gif", "--out", "flag.gif"])).toBe(0);
    const body = sentJson();
    expect(body.output_format).toBe("gif");
    expect(body, "IMAGE_GIF_NO_FRAME_DEFAULTS").not.toHaveProperty("frame_count");
    expect(body).not.toHaveProperty("frame_duration_ms");
  });

  test("a GIF edit with --ref carries the same fields over multipart", async () => {
    expect(await run(["make the door swing", "--ref", "photos/house.png", "--format", "gif", "--frames", "12", "--frame-duration", "150", "--out", "door.gif"])).toBe(0);
    expect(calls[0].url).toEndWith("/images/edits");
    const form = calls[0].init.body as FormData;
    expect(form.get("model")).toBe(SUNBURST);
    expect(form.get("output_format"), "IMAGE_GIF_EDIT").toBe("gif");
    expect(form.get("frame_count")).toBe("12");
    expect(form.get("frame_duration_ms")).toBe("150");
    expect(form.get("quality")).toBe("max");
    expect(form.get("complexity")).toBe("high");
  });

  const outOfRange: [string, string[], string][] = [
    ["--frames 1", ["--frames", "1"], "2 to 16"],
    ["--frames 17", ["--frames", "17"], "2 to 16"],
    ["--frames 4.5", ["--frames", "4.5"], "2 to 16"],
    ["--frame-duration 10", ["--frame-duration", "10"], "20 to 2000"],
    ["--frame-duration 2001", ["--frame-duration", "2001"], "20 to 2000"],
  ];
  for (const [label, flags, range] of outOfRange) {
    test(`${label} refuses with zero requests and names the range`, async () => {
      expect(await run(["x", "--format", "gif", ...flags])).toBe(1);
      expect(calls, "IMAGE_GIF_FRAME_RANGE").toHaveLength(0);
      expect(out.join("\n")).toContain(range);
    });
  }

  for (const flags of [["--frames", "9"], ["--frame-duration", "200"]]) {
    test(`${flags[0]} without --format gif refuses with zero requests`, async () => {
      expect(await run(["x", ...flags])).toBe(1);
      expect(calls).toHaveLength(0);
      expect(out.join("\n")).toContain("--format gif");
    });
  }

  test("GIF with --mask refuses before any request", async () => {
    expect(await run(["x", "--format", "gif", "--ref", "photos/house.png", "--mask", "photos/mask.png"])).toBe(1);
    expect(calls, "IMAGE_GIF_MASK").toHaveLength(0);
    expect(out.join("\n")).toMatch(/GIF.*mask/i);
  });

  test("GIF with --transparent refuses before any request", async () => {
    expect(await run(["x", "--format", "gif", "--transparent"])).toBe(1);
    expect(calls).toHaveLength(0);
    expect(out.join("\n")).toMatch(/GIF.*transparen/i);
  });

  test("GIF on a 2.5 model refuses and names the 2.6 models", async () => {
    expect(await run(["x", "--format", "gif", "--model", SUNBURST_25])).toBe(1);
    expect(calls, "IMAGE_GIF_MODEL").toHaveLength(0);
    expect(out.join("\n")).toContain(SUNBURST);
  });

  test("GIF on Gemini refuses before any request", async () => {
    process.env.GEMINI_API_KEY = "placeholder-never-sent";
    expect(await run(["x", "--format", "gif", "--provider", "gemini"])).toBe(1);
    expect(calls).toHaveLength(0);
    expect(out.join("\n")).toMatch(/GIF/);
  });

  test("a GIF dry run reports its cost as unknown", async () => {
    expect(await run(["x", "--format", "gif", "--aspect", "1:1", "--dry-run"])).toBe(0);
    expect(calls).toHaveLength(0);
    expect(report().model).toBe(SUNBURST);
    expect(report().output).toEndWith(".gif");
    expect(report().estimatedCostUsd, "IMAGE_GIF_DRY_RUN").toBeNull();
  });

  test("a refusal for missing GIF preview access names it and is not retryable", async () => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({ error: { message: "This organization does not have access to output_format gif for this model.", type: "invalid_request_error" } }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    expect(await run(["x", "--format", "gif", "--out", "x.gif"])).toBe(1);
    const said = out.join("\n");
    expect(said, "IMAGE_GIF_ACCESS_HINT").toContain("GIF preview access");
    expect(said).not.toContain("worth retrying");
    expect(said).not.toContain("region not supported");
  });
});
