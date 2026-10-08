import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { readCatalogue } from "./catalogue.ts";
import { CAPTURE_BROWSER_ARGUMENTS, captureStill, launchCaptureBrowser, startStaticServer } from "./browser.ts";
import { captureDemo } from "./demo.ts";
import { captureRuntime } from "./runtime.ts";
import { checkStorybookLayout } from "./storybook-layout.ts";
import { checkStorybookTheme } from "./storybook-theme.ts";
import { sha256,variantFile } from "./provenance.ts";

export interface CaptureJob {
  ids: string[];
  theme?: "dark" | "light";
  viewport?: { width: number; height: number };
  provenance: Record<string, unknown>;
}

async function run(): Promise<void> {
  const root = "/repo", output = "/captures", cache = "/fonts";
  const job: CaptureJob = JSON.parse(await readFile(resolve(output, "capture-job.json"), "utf8"));
  const catalogue = await readCatalogue(root);
  const index = JSON.parse(await readFile(resolve(root, "packages/ui-kit/storybook-static/index.json"), "utf8"));
  const selected = job.ids.map((id) => {
    const recipe = [...catalogue.recipes, ...catalogue.demo_sequences, ...catalogue.harness_requirements].find((recipe) => recipe.id === id);
    if (!recipe) throw new Error(`${id}: approved source is missing`);
    if (!Array.isArray(recipe.source)) {
      const entry = index.entries[recipe.source.story_id];
      const path = "./" + recipe.source.module.replace("packages/ui-kit/", "");
      if (!entry || entry.type !== "story" || entry.importPath !== path || entry.exportName !== recipe.source.export) {
        throw new Error(`${id}: built Storybook does not contain the declared actual source/export`);
      }
    }
    return recipe;
  });
  const server = await startStaticServer(resolve(root, "packages/ui-kit/storybook-static"));
  let browser: Browser | undefined;
  const artifacts: Array<Record<string, unknown>> = [];
  try {
    browser = await launchCaptureBrowser();
    await checkStorybookLayout(browser, root, cache, catalogue, server.origin);
    await checkStorybookTheme(browser, root, cache, catalogue, server.origin);
    const browserEvidence = {
      version: browser.version(),
      executable_sha256: sha256(await readFile(chromium.executablePath())),
      node:process.version,platform:process.platform,architecture:process.arch,
      launch_arguments:CAPTURE_BROWSER_ARGUMENTS,
    };
    for (const recipe of selected) {
      const theme = job.theme ?? recipe.theme;
      const sourcePaths=Array.isArray(recipe.source)?recipe.source:[recipe.source.module,...recipe.source.fixture_modules];
      const sourceFiles=await Promise.all(sourcePaths.map(async(path)=>({path,sha256:sha256(await readFile(resolve(root,path)))})));
      const provenance={...job.provenance,source_files:sourceFiles};
      if ("outputs" in recipe) {
        const result = await captureRuntime(browser, root, cache, catalogue, recipe, output, theme, job.viewport);
        artifacts.push({ id:recipe.id,file:result.files[0].file,files:result.files,theme,viewport:job.viewport ?? recipe.viewport,recipe,readiness:result.evidence,provenance,browser:browserEvidence });
        if (recipe.id === "approval-roundtrip") {
          for (let sample = 0; sample < 4; sample++) {
            const directory = resolve(output, `diagnostic-${sample}`);await mkdir(directory,{recursive:true});
            const measuredBrowser = sample < 2 ? browser : await launchCaptureBrowser();
            try { await captureRuntime(measuredBrowser,root,cache,catalogue,recipe,directory,theme,job.viewport); }
            finally { if (measuredBrowser !== browser) await measuredBrowser.close(); }
          }
        }

      } else if ("fallback" in recipe) {
        const result = await captureDemo(browser, root, cache, catalogue, server.origin, recipe, output, theme, job.viewport);
        artifacts.push({ id:recipe.id,file:result.files[0].file,files:result.files,theme,viewport:job.viewport ?? recipe.viewport,recipe,readiness:result.evidence,provenance,browser:browserEvidence });
        if (recipe.id === "approval-roundtrip") {
          for (let sample = 0; sample < 4; sample++) {
            const directory = resolve(output, `diagnostic-${sample}`);await mkdir(directory,{recursive:true});
            const measuredBrowser = sample < 2 ? browser : await launchCaptureBrowser();
            try { await captureRuntime(measuredBrowser,root,cache,catalogue,recipe,directory,theme,job.viewport); }
            finally { if (measuredBrowser !== browser) await measuredBrowser.close(); }
          }
        }

      } else {
        const file = variantFile(recipe.output,recipe.theme,theme,job.viewport);
        const { bytes, evidence } = await captureStill(browser, root, cache, catalogue, server.origin, recipe, theme, job.viewport);
        await writeFile(resolve(output, file), bytes);
        artifacts.push({ id: recipe.id, file,files:[{file,bytes:bytes.length,sha256:sha256(bytes)}], theme, viewport: job.viewport ?? catalogue.profiles[recipe.profile].viewport,
          bytes: bytes.length, recipe, readiness: evidence, provenance, browser: browserEvidence });
      }
      console.log(`${recipe.id}: rendered source/readiness/pixels verified`);
    }
    await writeFile(resolve(output, "capture-result.json"), JSON.stringify({ artifacts }, null, 2) + "\n");
  } finally { await browser?.close(); await server.close(); }
}

run().catch((error) => { console.error((error as Error).message); process.exitCode = 1; });
