/** Finite, data-only input roles. Unknown syntax never creates a consumed path. */
export interface SteeringReference { path: string; base: "file" | "scope"; module?: boolean; manifest?: boolean; instructionDepth?: number }
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};

/**
 * Consumer mapping (seed locations are deliberately separate):
 * - Bun bunfig root/test preload arrays: module inputs (Bun's config consumer).
 * - package.json scripts: executable/known interpreter entry and preload flags.
 * - Claude settings hooks command/args and .mcp.json mcpServers command/args:
 *   executable roles, never arbitrary command arguments (SDK settings schema).
 * - Pi settings extensions/skills/prompts/themes: paths relative to settings dir
 *   (DefaultPackageManager.resolve); package/glob/directory discovery is unknown.
 * - core JSON modules keys: local <key>/module.ts (loadModules/importManifest).
 * - JS/TS literal module imports: Bun.Transpiler.scan; not arbitrary literals.
 * No data/output/cache property, readFile call, or extension proves a role.
 * Unsupported commands, computed config/reads/imports and opaque discovery
 * report their source unavailable. No repository import/evaluation occurs.
 */
export function steeringReferences(path: string, text: string, instructionDepth?: number): { references: SteeringReference[]; unknown: boolean } {
  const references: SteeringReference[] = [];
  let unknown = false;
  const add = (value: unknown, base: SteeringReference["base"], module = false) => {
    if (typeof value !== "string" || !value || /[\u0000-\u001f\\$`*?{}~]/.test(value)) { unknown = true; return; }
    references.push({ path: value, base, module });
  };
  const command = (value: unknown, args?: unknown) => {
    if (typeof value !== "string") { unknown = true; return; }
    // Only one literal argv, with no shell substitutions/operators/redirections.
    // Exec-form hooks/MCP preserve argv; shell form accepts this narrow grammar.
    let words: string[];
    if (args !== undefined) {
      if (!Array.isArray(args) || !args.every(arg => typeof arg === "string")) { unknown = true; return; }
      words = [value, ...args];
    } else {
      if (/[\n\r$`;&|<>()\\]/.test(value)) { unknown = true; return; }
      const tokens = value.match(/"[^"\n]*"|'[^'\n]*'|[^\s"']+/g) ?? [];
      if (tokens.join(" ").replace(/\s+/g, " ") !== value.trim().replace(/\s+/g, " ")) { unknown = true; return; }
      words = tokens.map(token => /^["']/.test(token) ? token.slice(1, -1) : token);
    }
    const executable = words.shift();
    if (!executable) { unknown = true; return; }
    if (executable.startsWith("./") || executable.startsWith("../")) { add(executable, "scope"); unknown = true; return; }
    if (!["bun", "node", "sh", "bash", "python", "python3"].includes(executable)) { unknown = true; return; }
    if (executable === "bun" && words[0] === "run") words.shift();
    while (words.length) {
      const word = words.shift()!;
      if (["--preload", "--require", "-r", "--import"].includes(word)) { add(words.shift(), "scope", true); continue; }
      if (word === "--") continue;
      if (word.startsWith("-")) { unknown = true; return; }
      // Bare Bun script names can be package script aliases: do not guess.
      if (executable === "bun" && !word.includes("/")) { unknown = true; return; }
      add(word, "scope", executable === "bun" || executable === "node"); return;
    }
  };
  try {
    if (instructionDepth !== undefined) {
      // Supported subset of Claude's documented imports: standalone, literal
      // unquoted paths outside code. Inline/escaped/ambiguous imports stay
      // unknown. The consumer stops recursive expansion after four hops.
      let fence: string | undefined;
      if (instructionDepth < 4) for (const raw of text.split("\n")) {
        const delimiter = raw.match(/^ {0,3}(`{3,}|~{3,})/);
        if (delimiter) {
          const marker = delimiter[1]!;
          if (!fence) fence = marker;
          else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
          continue;
        }
        if (fence) continue;
        const line = raw.replace(/`+[^`]*`+/g, "");
        const match = line.match(/^ {0,3}@([^\s"'`\\]+)\s*$/);
        if (match) references.push({path:match[1]!, base:"file", instructionDepth:instructionDepth + 1});
        else if (/(?:^|\s)@/.test(line)) unknown = true;
      }
    } else if (/\.[cm]?[jt]sx?$/.test(path)) {
      const loader = path.endsWith("x") ? "tsx" : "ts";
      for (const reference of new Bun.Transpiler({ loader }).scan(text).imports) {
        if (reference.path.startsWith(".")) add(reference.path, "file", true);
        else if (!reference.path.startsWith("node:") && reference.path !== "bun" && !reference.path.startsWith("bun:")) unknown = true;
      }
      // Runtime resource reads (even literals), computed imports and config
      // evaluation have no role proof. Preserve that coverage limitation.
      if (/\b(?:import|require|readFile(?:Sync)?|file)\s*\(/.test(text) || /(?:^|\/)brain\.config\.ts$/.test(path)) unknown = true;
    } else if (path.endsWith("bunfig.toml")) {
      const config = object(Bun.TOML.parse(text));
      for (const section of [config, object(config.test)]) if (section.preload !== undefined) {
        if (!Array.isArray(section.preload)) unknown = true;
        else for (const value of section.preload) add(value, "file", true);
      }
    } else if (path.endsWith(".json")) {
      const config = object(JSON.parse(text));
      if (/(?:^|\/)package\.json$/.test(path)) for (const script of Object.values(object(config.scripts))) command(script);
      if (/(?:^|\/)brain\.config\.json$/.test(path)) for (const key of Object.keys(object(config.modules))) {
        if (key.startsWith("./")) references.push({path:`${key}/module`, base:"scope", manifest:true});
        else unknown = true;
      }
      if (/(?:^|\/)\.claude\/settings(?:\.local)?\.json$/.test(path)) {
        for (const groups of Object.values(object(config.hooks))) {
          if (!Array.isArray(groups)) { unknown = true; continue; }
          for (const group of groups) {
            const hooks = object(group).hooks;
            if (!Array.isArray(hooks)) { unknown = true; continue; }
            for (const raw of hooks) { const hook = object(raw); if (hook.type === "command") command(hook.command, hook.args); }
          }
        }
        if (config.enabledPlugins || config.extraKnownMarketplaces) unknown = true;
      }
      if (/(?:^|\/)\.mcp\.json$/.test(path)) for (const raw of Object.values(object(config.mcpServers))) {
        const server = object(raw);
        if (server.command !== undefined) command(server.command, server.args ?? []);
      }
      if (/(?:^|\/)\.pi\/settings\.json$/.test(path)) {
        for (const role of ["extensions", "skills", "prompts", "themes"]) if (config[role] !== undefined) {
          if (!Array.isArray(config[role])) unknown = true;
          else for (const value of config[role]) add(value, "file");
        }
        if (config.packages) unknown = true;
      }
    } else unknown = true;
  } catch { unknown = true; }
  return { references, unknown };
}
