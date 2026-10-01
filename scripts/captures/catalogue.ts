import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { z } from "zod";

const text = z.string().trim().min(1);
const id = text.regex(/^[a-z0-9]+(?:[-][a-z0-9]+)*(?:--[a-z0-9-]+)?$/);
const relativeFile = text.refine((value) => !value.startsWith("/") && !value.includes("\\") &&
  !value.split("/").includes("..") && !value.includes("\u0000"), "a repository-relative source path is required");
const png = text.regex(/^[a-z0-9][a-z0-9-]*\.png$/);
const dimensions = z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict();
const theme = z.enum(["dark", "light"]);
const source = z.object({
  kind: z.enum(["storybook-composition", "storybook-interaction"]),
  story_id: id,
  module: relativeFile,
  export: text.regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/),
  fixture_modules: z.array(relativeFile).min(1),
}).strict();
const consumer = z.object({ page: text, slot: text }).strict();
const still = z.object({
  id, features: z.array(text).min(1), source, theme, profile: text, inputs: text,
  readiness: z.object({ text_case_sensitive: z.boolean(), required_visible_text: z.array(text).min(1) }).strict(),
  output: png, consumer, alt: text, caption: text, claim_limits: text,
}).strict();
const demo = z.object({
  id, source, consumer, theme, viewport: dimensions, duration_seconds: z.number().positive(),
  output: text.regex(/^[a-z0-9][a-z0-9-]*\.webm$/),
  steps: z.array(z.object({ second: z.number().nonnegative(), action: text }).strict()).min(2),
  readiness: z.array(text).min(1), alt: text, caption: text, why_motion: text,
  fallback: z.object({ before: png, after: png, description: text }).strict(),
}).strict();
const schema = z.object({
  purpose: text,
  environment: z.object({
    browser_pin_source: text, browser_package_source: text, fixture_clock_source: text,
    locale: text, timezone: text, device_scale_factor: z.literal(1), reduced_motion: z.literal("reduce"),
    still_animations: z.literal("disabled"), font_source: relativeFile,
    font_families: z.record(z.string(), z.array(text).min(1)), font_delivery: text, network: text,
  }).strict(),
  profiles: z.record(z.string(), z.object({
    viewport: dimensions,
    crop: z.object({ selector: text, inset_px: z.number().int().nonnegative(), expected_element: dimensions, output: dimensions }).strict(),
  }).strict()),
  recipes: z.array(still).min(1),
  demo_sequences: z.array(demo),
  harness_requirements: z.array(z.object({
    id, feature: text, source: z.array(relativeFile).min(1), inputs: text, sequence: text,
    capture: text, acceptance: text, consumer: text, theme, viewport: dimensions, outputs: z.array(text.regex(/^[a-z0-9][a-z0-9-]*\.(?:png|json)$/)).min(2),
  }).strict()),
}).strict();

export type Catalogue = z.infer<typeof schema>;
export type StillRecipe = Catalogue["recipes"][number];
export type DemoRecipe = Catalogue["demo_sequences"][number];
export type Viewport = z.infer<typeof dimensions>;

/** Repository editorial data; not a published configuration API. */
export function parseCatalogue(markdown: string): Catalogue {
  const start = "<!-- feature-capture-data:start -->";
  const end = "<!-- feature-capture-data:end -->";
  if (markdown.split(start).length !== 2 || markdown.split(end).length !== 2) {
    throw new Error("Expected exactly one marked capture-data block");
  }
  const marked = markdown.slice(markdown.indexOf(start) + start.length, markdown.indexOf(end));
  const block = /^\s*```json\r?\n([\s\S]*?)\r?\n```\s*$/.exec(marked);
  if (!block) throw new Error("Expected exactly one JSON fence inside the marked capture-data block");
  let json: unknown;
  try { json = JSON.parse(block[1]); }
  catch { throw new Error("Invalid JSON in the marked capture-data block"); }
  const checked = schema.safeParse(json);
  if (!checked.success) {
    throw new Error(`Invalid capture catalogue: ${checked.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  const catalogue = checked.data;
  const ids = new Set<string>();
  const outputs = new Set<string>();
  for (const entry of [...catalogue.recipes, ...catalogue.demo_sequences, ...catalogue.harness_requirements]) {
    if (ids.has(entry.id)) throw new Error(`${entry.id}: duplicate recipe ID`);
    ids.add(entry.id);
  }
  for (const entry of [...catalogue.recipes, ...catalogue.demo_sequences, ...catalogue.harness_requirements]) {
    const files = "outputs" in entry ? entry.outputs : "fallback" in entry ? [entry.output, entry.fallback.before, entry.fallback.after] : [entry.output];
    for (const file of files) {
      if (outputs.has(file)) throw new Error(`${entry.id}: duplicate output ${file}`);
      outputs.add(file);
    }
  }
  for (const recipe of catalogue.recipes) {
    if (recipe.source.kind !== "storybook-composition") throw new Error(`${recipe.id}: invalid still source.kind`);
    const profile = catalogue.profiles[recipe.profile];
    if (!profile) throw new Error(`${recipe.id}: unknown profile ${recipe.profile}`);
    const { expected_element: box, output, inset_px: inset } = profile.crop;
    if (box.width - 2 * inset !== output.width || box.height - 2 * inset !== output.height) {
      throw new Error(`${recipe.id}: crop output does not match the element and inset`);
    }
  }
  for (const recipe of catalogue.demo_sequences) {
    if (recipe.source.kind !== "storybook-interaction") throw new Error(`${recipe.id}: invalid demo source.kind`);
    let previous = -1;
    for (const step of recipe.steps) {
      if (step.second <= previous || step.second >= recipe.duration_seconds) throw new Error(`${recipe.id}: invalid sequence timing`);
      previous = step.second;
    }
  }
  return catalogue;
}

/** Resolve every declared file without permitting a fixture path to escape the repository. */
export async function readCatalogue(root: string): Promise<Catalogue> {
  const catalogue = parseCatalogue(await readFile(resolve(root, "docs/process/feature-captures.md"), "utf8"));
  const realRoot = await realpath(root);
  const entries = [...catalogue.recipes, ...catalogue.demo_sequences];
  const paths = entries.flatMap((entry) => [entry.source.module, ...entry.source.fixture_modules]);
  paths.push(catalogue.environment.font_source, ...catalogue.harness_requirements.flatMap((entry) => entry.source));
  for (const file of new Set(paths)) {
    const owners = [
      ...entries.filter((entry) => entry.source.module === file || entry.source.fixture_modules.includes(file)),
      ...catalogue.harness_requirements.filter((entry) => entry.source.includes(file)),
    ].map((entry) => entry.id).join(", ") || "Capture environment";
    let actual: string;
    try { actual = await realpath(resolve(realRoot, file)); }
    catch { throw new Error(`${owners}: capture source is missing: ${file}`); }
    if (!actual.startsWith(realRoot + sep)) throw new Error(`${owners}: capture source escapes the repository: ${file}`);
  }
  for (const entry of entries) {
    const module = await readFile(resolve(realRoot, entry.source.module), "utf8");
    if (!new RegExp(`export const ${entry.source.export}\\s*=`).test(module)) {
      throw new Error(`${entry.id}: source export ${entry.source.export} is missing`);
    }
  }
  return catalogue;
}
