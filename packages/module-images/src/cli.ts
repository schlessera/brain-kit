import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, extname, relative } from "path";

import { safeResolve } from "@schlessera/brain";
import type { CommandContext, CommandModule } from "@schlessera/brain";

import { configSchema, type ImagesConfig } from "./module.js";
import { availableModels, providerFor } from "./providers/index.js";
import { route, type RoutingDecision } from "./routing.js";
import { ImageProviderError, type ImageInput, type ImageRequest } from "./types.js";

const HELP = `brain image — generate and edit images, routed by capability

  image "<prompt>"                 Generate an image
  image models                     List available models and what each is for

Output:
  --out <path>            Where to write, repo-relative. Default: <imagesDir>/<slug>-<date>.<ext>
  --format png|jpeg|webp  Default: whatever the chosen model returns
                          (every Gemini image model serves JPEG only)

Shape (--aspect and --resolution work on every model):
  --aspect <W:H>          1:1 2:3 3:2 3:4 4:3 4:5 5:4 9:16 16:9 21:9 on Gemini;
                          any ratio on OpenAI, where it becomes exact pixels
  --resolution <r>        512px | 1K | 2K | 4K
  --size <WxH>            Exact pixels — OpenAI only (16px grid, max edge 3840,
                          0.65-8.3MP). Requesting one routes away from Gemini.
  --quality <q>           low | medium | high | auto (OpenAI)
  --transparent           Transparent background (forces gpt-image-1.5)

Editing:
  --ref <path>            Reference image; repeatable
  --mask <path>           Alpha mask; transparent pixels mark what may change (OpenAI only)

Routing:
  --provider openai|gemini    Pin a provider
  --model <id>                Pin a model
  --text-in-image             The image is mostly type — poster, diagram, menu
  --characters                Recurring characters must stay consistent
  --no-watermark              Output must not carry SynthID
  --draft                     Cheapest acceptable model
  --dry-run                   Decide and price it, write nothing

Routing is by capability: a mask or a transparent background or an exact pixel
size forces OpenAI; heavy reference counts, character consistency and in-image
text favour Gemini. When nothing in the request settles it, the command stops
and asks rather than guessing — pass --model or --provider to proceed.

--json envelope: { output, provider, model, costUsd, costIsEstimate, bytes, reason }`;

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
  repeated: Record<string, string[]>;
}

const BOOLEANS = new Set([
  "transparent", "dry-run", "text-in-image", "characters", "no-watermark", "draft", "json", "human",
]);
const REPEATABLE = new Set(["ref"]);

/** Modules parse their own args; core hands them through untouched. */
export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const repeated: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (BOOLEANS.has(name)) {
      flags[name] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${name} requires a value`);
    }
    if (REPEATABLE.has(name)) (repeated[name] ??= []).push(value);
    else flags[name] = value;
  }
  return { positional, flags, repeated };
}

function slugify(prompt: string): string {
  return (
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .split("-")
      .slice(0, 6)
      .join("-") || "image"
  );
}

function loadImage(root: string, rel: string): ImageInput {
  const abs = safeResolve(root, rel);
  if (!abs) throw new Error(`Path escapes the brain root: ${rel}`);
  if (!existsSync(abs)) throw new Error(`No such file: ${rel}`);
  const ext = extname(abs).toLowerCase();
  const mime =
    ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
  return { data: new Uint8Array(readFileSync(abs)), mime, label: rel.split("/").pop() };
}

function describe(decision: RoutingDecision): string {
  if (decision.kind === "resolved") {
    return `${decision.model.provider}/${decision.model.id} — ${decision.reason}`;
  }
  return decision.reason;
}

export const imageCommand: CommandModule = {
  summary: "Generate and edit images, routed between providers by capability",
  helpBlock: HELP,

  async run(argv: string[], ctx: CommandContext): Promise<number> {
    let parsed: ParsedArgs;
    try {
      parsed = parseArgs(argv);
    } catch (e) {
      console.error((e as Error).message);
      return 1;
    }
    const cfg: ImagesConfig = configSchema.parse(ctx.config ?? {});
    const models = availableModels(cfg);

    if (parsed.positional[0] === "models") {
      const rows = models.map((m) => ({
        model: m.id,
        provider: m.provider,
        approxCostUsd1K: m.approxCostUsd1K,
        summary: m.summary,
      }));
      if (ctx.json) console.log(JSON.stringify({ models: rows }, null, 2));
      else if (rows.length === 0) {
        console.log("No image models available — set OPENAI_API_KEY or GEMINI_API_KEY.");
      } else {
        for (const r of rows) {
          console.log(`${r.model.padEnd(30)} ~$${r.approxCostUsd1K.toFixed(3)}/image  ${r.summary}`);
        }
      }
      return 0;
    }

    const prompt = parsed.positional.join(" ").trim();
    if (!prompt) {
      console.error('Usage: brain image "<prompt>" [flags] — see `brain image --help`');
      return 1;
    }

    let request: ImageRequest;
    try {
      request = {
        prompt,
        size: parsed.flags.size as string | undefined,
        aspect: parsed.flags.aspect as string | undefined,
        resolution: parsed.flags.resolution as ImageRequest["resolution"],
        quality: parsed.flags.quality as ImageRequest["quality"],
        format: parsed.flags.format as ImageRequest["format"],
        transparent: parsed.flags.transparent === true,
        references: (parsed.repeated.ref ?? []).map((r) => loadImage(ctx.root, r)),
        mask: parsed.flags.mask ? loadImage(ctx.root, parsed.flags.mask as string) : undefined,
      };
    } catch (e) {
      console.error((e as Error).message);
      return 1;
    }

    const decision = route({
      request,
      available: models,
      pinnedProvider: parsed.flags.provider as "openai" | "gemini" | undefined,
      pinnedModel: parsed.flags.model as string | undefined,
      intent: {
        textInImage: parsed.flags["text-in-image"] === true,
        characterConsistency: parsed.flags.characters === true,
        noWatermark: parsed.flags["no-watermark"] === true,
        draft: parsed.flags.draft === true,
      },
    });

    if (decision.kind === "impossible") {
      console.error(decision.reason);
      return 1;
    }
    if (decision.kind === "ambiguous") {
      const lines = decision.candidates.map(
        (m) => `  --model ${m.id.padEnd(30)} ~$${m.approxCostUsd1K.toFixed(3)}  ${m.summary}`
      );
      if (ctx.json) {
        console.log(
          JSON.stringify(
            { status: "ambiguous", reason: decision.reason, candidates: decision.candidates },
            null,
            2
          )
        );
      } else {
        console.error(`${decision.reason}\n\nPick one:\n${lines.join("\n")}`);
      }
      return 1;
    }

    const model = decision.model;
    // The extension follows the format the chosen model actually returns —
    // Gemini serves JPEG whatever the file is called, and writing those bytes
    // into a .png would be a lie that only shows up when something opens it.
    const ext = request.format ?? model.defaultFormat;
    const outRel =
      (parsed.flags.out as string | undefined) ??
      `${cfg.imagesDir}/${slugify(prompt)}-${new Date().toISOString().slice(0, 10)}.${ext}`;
    const outAbs = safeResolve(ctx.root, outRel);
    if (!outAbs) {
      console.error(`Output path escapes the brain root: ${outRel}`);
      return 1;
    }

    if (parsed.flags["dry-run"] === true) {
      const payload = {
        status: "dry-run",
        output: relative(ctx.root, outAbs),
        provider: model.provider,
        model: model.id,
        estimatedCostUsd: model.approxCostUsd1K,
        reason: decision.reason,
      };
      if (ctx.json) console.log(JSON.stringify(payload, null, 2));
      else {
        console.log(`Would use ${describe(decision)}`);
        console.log(`Would write ${payload.output} (~$${model.approxCostUsd1K.toFixed(3)})`);
      }
      return 0;
    }

    const provider = providerFor(model.provider);
    const apiKey = process.env[provider.apiKeyEnv];
    if (!apiKey) {
      console.error(`${provider.apiKeyEnv} is not set.`);
      return 1;
    }

    let result;
    try {
      result = await provider.generate(model.id, request, apiKey);
    } catch (e) {
      const err = e as ImageProviderError;
      console.error(err.message);
      if (err.opts?.retryable) console.error("This one is worth retrying.");
      return 1;
    }

    // What came back wins over what the filename claimed: a model may serve a
    // different format than the extension implies, and writing those bytes
    // under the wrong name only surfaces when something tries to open it.
    const [first, ...rest] = result.images;
    const actualExt = first.mime.replace("image/", "").replace("jpg", "jpeg");
    let finalAbs = outAbs;
    let renamed: string | undefined;
    if (extname(outAbs).slice(1).toLowerCase().replace("jpg", "jpeg") !== actualExt) {
      finalAbs = outAbs.replace(/\.[^./\\]+$/, "") + "." + actualExt;
      renamed = `${relative(ctx.root, outAbs)} → ${relative(ctx.root, finalAbs)} (model returned ${actualExt})`;
    }

    mkdirSync(dirname(finalAbs), { recursive: true });
    writeFileSync(finalAbs, first.data);
    const written = [relative(ctx.root, finalAbs)];
    for (const [i, extra] of rest.entries()) {
      const alt = finalAbs.replace(/(\.[^.]+)$/, `-${i + 2}$1`);
      writeFileSync(alt, extra.data);
      written.push(relative(ctx.root, alt));
    }

    const payload = {
      output: written[0],
      outputs: written,
      provider: result.provider,
      model: result.model,
      costUsd: result.costUsd ?? null,
      costIsEstimate: result.costIsEstimate,
      bytes: first.data.byteLength,
      reason: decision.reason,
      note: result.note ?? null,
      renamed: renamed ?? null,
    };
    if (ctx.json) console.log(JSON.stringify(payload, null, 2));
    else {
      const cost = result.costUsd !== undefined ? ` (~$${result.costUsd.toFixed(3)})` : "";
      console.log(`Wrote ${written.join(", ")} via ${result.provider}/${result.model}${cost}`);
      console.log(`  ${decision.reason}`);
      if (renamed) console.log(`  renamed: ${renamed}`);
      if (result.note) console.log(`  model said: ${result.note}`);
    }
    return 0;
  },
};

export default imageCommand;
