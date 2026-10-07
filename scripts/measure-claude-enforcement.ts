// #901: real production wiring, real CLI, scripted loopback inference.
// Run in the same loopback-only network namespace as measure-claude-runtime.
// The query wrapper observes existing handlers and messages; it forwards their
// inputs and outputs unchanged. It installs no permission decision of its own.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { HookJSONOutput, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { type PermissionRequest } from "@schlessera/brain-ui-sdk/server";
import { resetRtkProbe } from "../packages/ui-sdk/src/server/rtk.js";
import { createClaudeBackend, type InferenceProfile } from "../packages/ui-backend-claude/src/index";
import { CLEARED_API_CREDENTIALS } from "../packages/ui-backend-claude/src/subscription";
import { resultText, scriptedModel } from "./measure-claude-runtime";

const entry = Bun.resolveSync("@anthropic-ai/claude-agent-sdk", join(import.meta.dir, "../packages/ui-backend-claude/src"));
const { query } = await import(entry) as typeof import("@anthropic-ai/claude-agent-sdk");
const agentSdk = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")).version as string;
const callId = "toolu_probe_1";
const denial = "production-probe-denied";
const model = scriptedModel();
const results: unknown[] = [];
let failures = 0;

try {
  for (const scenario of ["plain", "settings-allow", "settings-hook-allow", "rtk-rewrite"] as const) {
    for (const arm of ["denied", "approved", "allowlisted"] as const) {
      const root = mkdtempSync(join(tmpdir(), "enforcement-probe-"));
      const cwd = join(root, "cwd"), home = join(root, "home"), bin = join(root, "bin");
      for (const dir of [cwd, home, bin]) mkdirSync(dir);
      const original = join(cwd, "original"), rewritten = join(cwd, "rewritten"), settingsMarker = join(cwd, "settings-hook-ran");
      const command = `touch ${original}`;
      // Controlled rewrite oracle, invoked by the production RTK hook. Other
      // scenarios explicitly decline, so host RTK installations cannot vary it.
      writeFileSync(join(bin, "rtk"), '#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\ncat > /dev/null\n' +
        (scenario === "rtk-rewrite" ? `printf '%s\\n' '${JSON.stringify({ hookSpecificOutput: { updatedInput: { command: `touch ${rewritten}` } } })}'\n` : "exit 0\n"));
      chmodSync(join(bin, "rtk"), 0o755);
      if (scenario.startsWith("settings-")) {
        mkdirSync(join(cwd, ".claude"));
        const settings = scenario === "settings-allow" ? { permissions: { allow: ["Bash(touch:*)", "Bash"] } } : {
          hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command:
            `touch ${settingsMarker}; echo '${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } })}'` }] }] },
        };
        writeFileSync(join(cwd, ".claude/settings.json"), JSON.stringify(settings));
      }
      const saved = { ...process.env };
      Object.assign(process.env, { HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), PATH: `${bin}:${saved.PATH ?? "/usr/bin:/bin"}` });
      resetRtkProbe();
      const log = model.plan({ name: "Bash", input: { command } });
      const hookCalls: Array<{ index: string; input: unknown; output: HookJSONOutput }> = [];
      const callbackCalls: Array<{ input: unknown; output: unknown }> = [];
      const requests: PermissionRequest[] = [];
      const toolResults: Array<{ isError: boolean; text: string }> = [];
      let claudeCode: string | undefined, permissionMode: Options["permissionMode"], resultSubtype: string | undefined;
      let toolUseSeen = false, error: string | undefined;
      let matchingHooks: string[] = [];
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 20_000);
      try {
        const observedQuery: typeof query = (params) => {
          const options = params.options!;
          permissionMode = options.permissionMode;
          matchingHooks = (options.hooks?.PreToolUse ?? []).flatMap((matcher, i) =>
            !matcher.matcher || new RegExp(matcher.matcher).test("Bash") ? matcher.hooks.map((_, j) => `${i}:${j}`) : []);
          const originalCallback = options.canUseTool!;
          const hooks = { ...options.hooks, PreToolUse: options.hooks?.PreToolUse?.map((matcher, i) => ({
            ...matcher, hooks: matcher.hooks.map((hook, j) => async (input, id, context) => {
              const output = await hook(input, id, context);
              if ("tool_use_id" in input && input.tool_use_id === callId) hookCalls.push({ index: `${i}:${j}`, input, output });
              return output;
            }),
          })) } satisfies Options["hooks"];
          const stream = query({ ...params, options: { ...options, hooks, canUseTool: async (name, input, context) => {
            const output = await originalCallback(name, input, context);
            if (context.toolUseID === callId) callbackCalls.push({ input, output });
            return output;
          } } });
          return new Proxy(stream, { get(target, key) {
            if (key === Symbol.asyncIterator) return async function* () {
              for await (const message of target) {
                observe(message);
                yield message;
              }
            };
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          } });
        };
        function observe(message: SDKMessage): void {
          if (message.type === "system" && message.subtype === "init") claudeCode = (message as { claude_code_version?: string }).claude_code_version;
          if (message.type === "assistant" && message.parent_tool_use_id === null)
            toolUseSeen ||= message.message.content.some((part) => part.type === "tool_use" && part.id === callId && part.name === "Bash");
          if (message.type === "user" && Array.isArray(message.message.content))
            for (const part of message.message.content as Array<{ type: string; tool_use_id?: string; is_error?: boolean; content?: unknown }>)
              if (part.type === "tool_result" && part.tool_use_id === callId) toolResults.push({ isError: part.is_error === true, text: resultText(part.content) });
          if (message.type === "result") resultSubtype = message.subtype;
        }
        const profile: InferenceProfile = { id: "probe", label: "Probe", model: "claude-sonnet-4-6", billing: "api", requiredEnvKeys: [],
          buildEnv: () => ({ ...CLEARED_API_CREDENTIALS, ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "offline-fixture", CLAUDE_CODE_OAUTH_TOKEN: "",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }) };
        const backend = createClaudeBackend({ brainPath: cwd, profiles: [profile], allowedTools: arm === "allowlisted" ? ["Bash"] : [], queryFn: observedQuery, log: () => {} });
        await backend.startTurn({ prompt: "Run the planned tool call.", profileId: "probe", signal: controller.signal, enforceAllowedTools: true,
          bridge: { emit: () => {}, requestPermission: async (request) => {
            requests.push(request);
            return arm === "approved" ? { behavior: "allow", updatedInput: request.input } : { behavior: "deny", message: denial };
          } } });
      } catch (e) { error = e instanceof Error ? e.message : String(e); }
      finally {
        clearTimeout(deadline);
        for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
        Object.assign(process.env, saved);
        resetRtkProbe();
      }
      const effects = { original: existsSync(original), rewritten: existsSync(rewritten), settingsHook: existsSync(settingsMarker) };
      const ask = hookCalls.some(({ output }) => "hookSpecificOutput" in output && output.hookSpecificOutput?.hookEventName === "PreToolUse" && output.hookSpecificOutput.permissionDecision === "ask");
      const missing = !log.callSent || !toolUseSeen || !claudeCode || resultSubtype !== "success" || matchingHooks.length === 0 ||
        matchingHooks.some((index) => !hookCalls.some((h) => h.index === index)) || toolResults.length === 0 ||
        (scenario === "settings-hook-allow" && !effects.settingsHook) || error;
      const ran = scenario === "rtk-rewrite" ? effects.rewritten && !effects.original : effects.original && !effects.rewritten;
      const authorized = arm === "allowlisted" ? requests.length === 0 : ask && requests.some((r) => r.toolUseId === callId && r.outsideEnforcedAllowlist === true) && callbackCalls.length > 0;
      const correct = authorized && (arm === "denied" ? !effects.original && !effects.rewritten && toolResults.every((r) => r.isError && r.text.includes(denial)) :
        ran && toolResults.some((r) => !r.isError));
      const verdict = missing ? "inconclusive" : correct ? "pass" : "fail";
      if (verdict !== "pass") failures++;
      // Stable fictional scratch paths; never save actual hosts, credentials or
      // installation paths in the report that a reviewer may publish.
      const observation = { scenario, arm, agentSdk, claudeCode, permissionMode: permissionMode ?? "omitted", verdict, error,
        ...(verdict !== "pass" ? { detail: missing ? "The planned call, every matching hook, CLI init, successful turn and nonempty result must be observed." :
          !authorized ? "The outside-allowlist call must reach the production ask, callback and bridge; an allowlisted control must need no bridge grant." :
          "A denied call must leave neither file and return the named denial; a permitted control must create only its intended file." } : {}),
        planned: { name: "Bash", input: { command }, sent: log.callSent, toolUseSeen }, hooks: hookCalls, callbacks: callbackCalls,
        requests, toolResults, effects, resultSubtype };
      results.push(JSON.parse(JSON.stringify(observation).replaceAll(root, "<scratch>")));
      rmSync(root, { recursive: true, force: true });
    }
  }
  const report = JSON.stringify({ date: new Date().toISOString(), agentSdk, results }, null, 2);
  const out = process.argv[process.argv.indexOf("--out") + 1];
  if (process.argv.includes("--out") && out) writeFileSync(out, report + "\n");
  console.log(report);
  process.exitCode = failures ? 1 : 0;
} finally { model.stop(); }
