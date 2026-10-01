import { existsSync, readFileSync, realpathSync } from "fs";
import { join, relative, resolve, sep } from "path";
import type { BrainContext } from "./context.js";
import type { LoadedModule } from "./module-types.js";
import { estimateTokens } from "./context-assembler.js";
import { discoverSkills } from "./skills/discover.js";
import { codeRanges, inRanges } from "./markdown-code.js";
import { generatedRegionSpan, replaceGeneratedRegion } from "./generated-regions.js";
import { safeResolve } from "./safe-path.js";
import { claudeImports } from "./instructions-weight.js";

const OWNER = /^[a-z][a-z0-9-]{0,30}$/;
const FILES = ["CLAUDE.md", "AGENTS.md", "GEMINI.md"];

function migration(file: string, reason: string): never {
  throw new Error(`${file}: ${reason}. No changes made. Explicitly migrate mixed generated sections: keep personal prose outside generated regions and place authoritative module text in module-owned regions after their ownership slots. See docs/modules.md (instruction migration).`);
}

/** The hypothetical active cost uses the same discovery precedence and estimator as doctor. */
export function moduleContextTokens(root: string, modules: LoadedModule[], mod: LoadedModule): number {
  const active = modules.map((m) => m === mod ? { ...m, state: "active" as const } : m);
  const descriptions = discoverSkills({ root, modules: active }).skills.filter((s) => {
    const dir = mod.manifest.skills ? resolve(mod.dir, mod.manifest.skills) : null;
    const inside = dir ? relative(dir, s.dir) : "..";
    return dir !== null && s.source === "module" && inside !== ".." && !inside.startsWith(".." + sep) &&
      s.frontmatter["disable-model-invocation"] !== true;
  });
  return estimateTokens(mod.manifest.instructions?.text ?? "") + descriptions.reduce((n, s) => n + estimateTokens(s.description), 0);
}

export interface InstructionEdit { path: string; before: string | null; after: string }

/** Plan every file before any write. Slots preserve positions, never a saved copy of prose. */
export function planModuleInstructions(brain: BrainContext, modules: LoadedModule[]): InstructionEdit[] {
  const names = new Set(modules.map((m) => m.manifest.name));
  for (const m of modules) {
    if (m.manifest.instructions && !OWNER.test(m.manifest.name)) migration("module contribution", `invalid instruction owner ${JSON.stringify(m.manifest.name)}`);
    if (/<!--\s*\/?brain:(?:generated|module-instructions):/.test(m.manifest.instructions?.text ?? "")) {
      migration("module contribution", `module ${m.manifest.name} instruction text contains ownership markers`);
    }
  }
  const targets = new Set(["CLAUDE.md"]);
  if (brain.config?.skills?.emitters?.includes("codex")) targets.add("AGENTS.md");
  if (brain.config?.skills?.emitters?.includes("gemini")) targets.add("GEMINI.md");
  const edits: InstructionEdit[] = [];
  const paths = new Set<string>();
  for (const file of FILES) {
    if (!targets.has(file) && !existsSync(join(brain.root, file))) continue;
    const path = safeResolve(brain.root, file);
    if (!path) migration(file, "instruction file escapes the brain root");
    const physical = existsSync(path) ? realpathSync(path) : path;
    if (paths.has(physical)) migration(file, "instruction files alias one another");
    paths.add(physical);
    const before = existsSync(path) ? readFileSync(path, "utf8") : null;
    const importsAgents = file === "CLAUDE.md" &&
      (targets.has("AGENTS.md") || existsSync(join(brain.root, "AGENTS.md"))) &&
      claudeImports(before ?? "").some((path) => resolve(brain.root, path) === join(brain.root, "AGENTS.md"));
    const after = renderModuleInstructions(before ?? "", modules, names, file, !importsAgents);
    if (before === null && after === "") continue;
    if (after !== before) edits.push({ path, before, after });
  }
  return edits;
}

function renderModuleInstructions(text: string, modules: LoadedModule[], names: Set<string>, file: string, includeContext: boolean): string {
  const code = codeRanges(text);
  const slots = new Map<string, number>();
  const regions = new Map<string, [number, number]>();
  let offset = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.replace(/\r$/, "").trim();
    const at = offset + line.indexOf(trimmed);
    if (!inRanges(code, at)) {
      if (/<!--\s*\/?brain:module-instructions:/.test(trimmed)) {
        const match = /^<!-- brain:module-instructions:([a-z][a-z0-9-]{0,30}) -->$/.exec(trimmed);
        if (!match || !names.has(match[1]!) || slots.has(match[1]!)) migration(file, "unknown, duplicate or malformed module ownership slot");
        slots.set(match[1]!, offset + line.length + 1);
      }
      if (/<!--\s*\/?brain:generated:/.test(trimmed)) {
        const match = /^<!-- (\/?)brain:generated:module-([a-z][a-z0-9-]{0,30}) -->$/.exec(trimmed);
        if (!match || !names.has(match[2]!)) migration(file, "legacy mixed section or unknown/malformed generated region owner");
        const owner = match[2]!;
        try {
          const span = generatedRegionSpan(text, `module-${owner}`);
          if (!span) migration(file, "module region cannot be located");
          regions.set(owner, span);
        } catch (e) { migration(file, (e as Error).message); }
      }
    }
    offset += line.length + 1;
  }
  for (const [owner, [start]] of regions) {
    if (slots.get(owner) !== start) migration(file, `module ${owner} region must immediately follow its ownership slot`);
  }
  // No nesting or overlapping owners; both can conceal somebody else's prose.
  const spans = [...regions.values()].sort((a, b) => a[0] - b[0]);
  if (spans.some((s, i) => i > 0 && s[0] < spans[i - 1]![1])) migration(file, "module instruction regions overlap");
  if ([...slots.values()].some((at) => spans.some(([start, end]) => at > start && at < end))) {
    migration(file, "module ownership slots are nested in generated text");
  }
  let next = text;
  const changes: { start: number; end: number; text: string }[] = [];
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  for (const m of modules) {
    const owner = m.manifest.name;
    const contributed = m.manifest.instructions?.text;
    const region = regions.get(owner);
    const at = slots.get(owner);
    if (region && !contributed) migration(file, `module ${owner} has no authoritative instruction contribution`);
    const content = includeContext && m.state !== "dormant" ? contributed : undefined;
    const block = content ? replaceGeneratedRegion("", `module-${owner}`, content).replace(/\n/g, eol) : "";
    if (region) {
      const [start, close] = region;
      if (!text.startsWith(eol, close)) migration(file, `module ${owner} closing marker must end with a newline`);
      changes.push({ start, end: close + eol.length, text: block });
    } else if (at !== undefined) {
      if (at > text.length) migration(file, "ownership slot must end with a newline");
      changes.push({ start: at, end: at, text: block });
    } else if (contributed) {
      const gap = next === "" || next.endsWith(eol) ? "" : eol;
      next += `${gap}<!-- brain:module-instructions:${owner} -->${eol}${block}`;
    }
  }
  for (const c of changes.sort((a, b) => b.start - a.start)) next = next.slice(0, c.start) + c.text + next.slice(c.end);
  // Appended slots must stay visible (an unclosed fence would swallow them).
  const nextCode = codeRanges(next);
  for (const m of modules) {
    if (!m.manifest.instructions) continue;
    const slot = `<!-- brain:module-instructions:${m.manifest.name} -->`;
    const visible = [...next.matchAll(new RegExp(slot, "g"))].some((match) => !inRanges(nextCode, match.index));
    if (!visible) migration(file, "module ownership slot would be inside a code block");
  }
  return next;
}
