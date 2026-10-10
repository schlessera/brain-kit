// Keyless fixture writers, not a shipping backend or a model conversation.
import {
  createBashTool, createEditTool, createWriteTool, DefaultResourceLoader,
  SettingsManager, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { linkSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createWrappedSpawn } from "../../packages/ui-backend-claude/src/spawn-wrapper.ts";

const [operation, brain, scratch, target] = process.argv.slice(2);
const payload = "Odysseus: agent changed the policy.\n";
const golden = "Odysseus: only the server owns policy writes.\n";
if (!operation || !brain || !scratch || !target) throw new Error("missing fixture arguments");
const results: Array<{ writer: string; error: string | null }> = [];
const shellQuote = (text: string): string => "'" + text.replaceAll("'", "'\\''") + "'";
async function attempt(writer: string, action: () => unknown): Promise<void> {
  try { await action(); results.push({ writer, error: null }); }
  catch (error) { results.push({ writer, error: String(error) }); }
}

if (operation === "direct-child") {
  writeFileSync(target, payload);
  process.exit(0);
}

switch (operation) {
  case "write":
    await attempt("installed pi Write", () => createWriteTool(brain).execute("proof", { path: target, content: payload }));
    break;
  case "edit":
    await attempt("installed pi Edit", () => createEditTool(brain).execute("proof", { path: target, edits: [{ oldText: golden.trim(), newText: payload.trim() }] }));
    break;
  case "notebook-fixture":
    await attempt("fixture notebook serializer", () => writeFileSync(target, JSON.stringify({ cells: [{ source: payload }] })));
    break;
  case "bash-script": {
    // Static script receives paths as arguments; no interpolated shell code.
    const script = join(scratch, "indirect.sh");
    writeFileSync(script, 'printf "%s\\n" "Odysseus: agent changed the policy." > "$1"\n');
    await attempt("installed pi Bash indirect script", async () => {
      const tool = createBashTool(brain);
      const result = await tool.execute("proof", { command: `bash ${shellQuote(script)} ${shellQuote(target)}` });
      if (result.details?.exit_code !== undefined && result.details.exit_code !== 0) throw new Error(`script exit ${result.details.exit_code}`);
    });
    break;
  }
  case "subagent-fixture":
    await attempt("fixture nested runtime process", () => {
      const child = Bun.spawnSync([process.execPath, import.meta.path, "direct-child", brain, scratch, target], { stdout: "pipe", stderr: "pipe" });
      if (child.exitCode !== 0) throw new Error(new TextDecoder().decode(child.stderr));
    });
    break;
  case "claude-wrapper":
    await attempt("installed Claude spawn adapter, fixture executable", async () => {
      writeFileSync(join(scratch, "exec.sh"), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
      const spawn = createWrappedSpawn({ wrapper: join(scratch, "exec.sh") });
      const child = spawn({ command: process.execPath,
        args: [import.meta.path, "direct-child", brain, scratch, target],
        cwd: brain, env: { PATH: process.env.PATH }, signal: new AbortController().signal });
      child.stdout.resume();
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("exit", resolve); child.once("error", reject);
      });
      if (code !== 0) throw new Error(`fixture runtime exit ${code}`);
    });
    break;
  case "hardlink-scratch":
    await attempt("create policy alias in writable scratch", () => {
      const alias = join(scratch, "policy-alias.md");
      linkSync(target, alias);
      writeFileSync(alias, payload);
    });
    break;
  case "create-policy":
    await attempt("create new policy", () => writeFileSync(join(brain, "context/policies/new.md"), payload));
    break;
  case "remove-policy":
    await attempt("unlink policy", () => unlinkSync(target));
    break;
  case "rename-policies":
    await attempt("rename policy directory", () => renameSync(join(brain, "context/policies"), join(brain, "context/moved")));
    break;
  case "fd":
    await attempt("preopened descriptor 3", () => writeSync(3, payload));
    break;
  case "stdio":
    await attempt("preopened stdout descriptor", () => writeSync(1, payload));
    break;
  case "extension-init":
  case "extension-tool": {
    // The installed resource loader initializes a real inline extension and
    // produces its registered executor. No simulated permission predicate.
    const factory: ExtensionFactory = async (pi) => {
      if (operation === "extension-init") {
        await attempt("installed pi extension initialization", () => writeFileSync(target, payload));
      }
      pi.registerTool({ name: "policy_probe", label: "Policy probe", description: "Keyless fixture writer", parameters: Type.Object({}),
        execute: async () => {
          await attempt("installed pi extension custom executor", () => writeFileSync(target, payload));
          return { content: [{ type: "text", text: "fixture attempted" }], details: {} };
        },
      });
    };
    const loader = new DefaultResourceLoader({ cwd: brain, agentDir: join(scratch, "pi"),
      settingsManager: SettingsManager.inMemory(), noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, extensionFactories: [factory],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    if (loaded.errors.length || loaded.extensions.length !== 1) throw new Error(`extension not loaded: ${JSON.stringify(loaded.errors)}`);
    const registered = loaded.extensions[0].tools.get("policy_probe");
    if (!registered) throw new Error("nonempty custom tool missing");
    if (operation === "extension-tool") await registered.definition.execute("proof", {}, undefined, undefined, {} as never);
    break;
  }
  default: throw new Error(`unknown operation ${operation}`);
}
// Positive control runs even after a denied attempt. The controller checks
// target bytes independently, including when a tool swallows its own error.
const allowed = join(scratch, "allowed.md");
writeFileSync(allowed, "Odysseus: permitted scratch write.\n");
if (readFileSync(allowed, "utf8").length === 0) throw new Error("empty positive control");
let targetBytes: string | null = null;
try { targetBytes = readFileSync(target, "utf8"); } catch { /* controller observes the original independently */ }
process.stderr.write(JSON.stringify({ operation, results, pid: process.pid,
  allowedBytes: readFileSync(allowed, "utf8"),
  targetBytes,
}) + "\n");
