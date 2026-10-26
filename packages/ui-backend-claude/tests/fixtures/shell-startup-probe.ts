/** Real SDK-selected CLI in the production worker; caller supplies an offline namespace. */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { LaunchedWorker } from "@schlessera/brain-ui-sdk/internal";
import { createWorkerSpawn } from "../../src/worker-spawn.js";
import { createStateLedger } from "../../src/worker-state-budget.js";
import { nativeModelReply } from "../helpers/native-model-reply.js";
import { createFixtureWorkerStartupView, prepareFixtureWorkerSandbox } from "../../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";

const root = process.argv[2]!;
const fallback = process.argv[3] === "fallback";
const profile = process.argv[4] === "governed" ? "governed" : process.argv[4] === "strict" ? "strict" : undefined;
const startupEnv = process.argv[5] === "startup-env";
const shell = process.argv[6] === "zsh" ? "/usr/bin/zsh" : "/bin/bash";
const brain = join(root, "ithaca"), home = join(root, "home"), saved = join(home, ".claude"), planted = join(home, "planted-bin");
for (const path of [brain, home, saved, planted]) mkdirSync(path, { recursive: true });
writeFileSync(join(home, "voyage.txt"), "Odysseus returns to Ithaca.\n");
writeFileSync(join(planted, "ithaca-profile-probe"), "#!/bin/sh\necho planted\n", { mode: 0o755 });
for (const name of [".bashrc", ".bash_profile", ".bash_login", ".profile", ".bash_logout", ".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout"]) writeFileSync(join(home, name), [
  `echo ithaca-${name}-stdout`,
  `echo ithaca-${name}-stderr >&2`,
  "export BRAIN_TEST_PROFILE_LEAK=1",
  `export PATH='${planted}':"$PATH"`,
  "git() { echo planted; }",
  `printf 'file=${name} HOME=%s login=%s command=%s\\n' "$HOME" "$(if [ -n "\${ZSH_VERSION:-}" ]; then [[ -o login ]]; else shopt -q login_shell; fi && echo yes || echo no)" "\${BASH_EXECUTION_STRING:-\${ZSH_EXECUTION_STRING:-}}" >> "$BRAIN_WORKER_SCRATCH/startup.log"`,
].join("\n") + "\n");
// Only fictional authentication is available, to the loopback fixture below.
const credential = JSON.stringify({ claudeAiOauth: { accessToken: "odysseus-offline-oauth", refreshToken: "odysseus-offline-refresh",
  expiresAt: Date.now() + 3_600_000, scopes: ["user:inference", "user:profile"], subscriptionType: "max" } });
writeFileSync(join(saved, ".credentials.json"), credential);
writeFileSync(join(saved, "settings.json"), JSON.stringify({ env: { ITHACA_CONFIG_RETAINED: "yes" } }));
const wrapper = join(root, "worker-wrapper.sh");
// A shell wrapper would discard exported function variables before the CLI.
writeFileSync(wrapper, "#!/usr/bin/python3\nimport os, sys\n" + (fallback
  ? 'with open(os.path.join(os.environ["CLAUDE_CONFIG_DIR"], "shell-snapshots"), "w") as file: file.write("snapshot intentionally unavailable\\n")\n' : "")
  + 'os.execv(sys.argv[1], sys.argv[1:])\n', { mode: 0o755 });
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const homeProbe = [
  "import errno, json, os",
  "home = os.environ['HOME']",
  "errors = {}",
  "for relative in ['.npm', 'go', '.cargo', '.cache/brain-kit/geo', '.local/bin']:",
  "    try:",
  "        os.makedirs(os.path.join(home, relative), exist_ok=True)",
  "        errors[relative] = None",
  "    except OSError as error:",
  "        errors[relative] = errno.errorcode[error.errno]",
  "print('home-probe=' + json.dumps({'errors': errors, 'readonly': bool(os.statvfs(home).f_flag & os.ST_RDONLY), 'empty': not os.listdir(home), 'separateFromState': os.stat(home).st_dev != os.stat(os.environ['CLAUDE_CONFIG_DIR']).st_dev}))",
].join("\n");
const command = 'echo hi; type git; echo "${BRAIN_TEST_PROFILE_LEAK:-unset}"; '
  + 'printf "config=%s\\n" "$ITHACA_CONFIG_RETAINED"; '
  + 'if [ -n "${ZSH_VERSION:-}" ]; then echo actual-shell=zsh; elif [ -n "${BASH_VERSION:-}" ]; then echo actual-shell=bash; else echo actual-shell=unknown; fi; '
  + 'command -v ithaca-profile-probe || true; '
  + 'printf "home=%s xdg=%s\\n" "$HOME" "$XDG_CONFIG_HOME"; '
  + 'printf "Athena charts.\\n" > "$XDG_CONFIG_HOME/voyage.txt"; '
  + 'cat "' + home + '/voyage.txt"; '
  + '(echo changed > "' + home + '/voyage.txt") 2>/dev/null || echo real-home-read-only; '
  + 'python3 -I -S -c ' + quote(homeProbe)
  + (profile ? "" : '; ' + quote(process.execPath) + ' --config=/dev/null --no-env-file '
    + quote(new URL("./shell-home-consumers.ts", import.meta.url).pathname));
const expectedGit = Bun.which("git", { PATH: "/usr/bin:/bin" });
if (!expectedGit) throw new Error("The shell fixture requires an installed git executable.");
let worker: LaunchedWorker | undefined;
let sent = false, selected: { command: string; args: string[] } | undefined;
const messages: unknown[] = [], requests: unknown[] = [], stderr: string[] = [];
const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 25_000);
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (!new URL(request.url).pathname.endsWith("/messages")) return Response.json({});
  const body = await request.json() as { messages: unknown[]; tools?: { name: string }[] };
  // Native startup helpers can make their own Messages requests. Only the
  // actual agent roster receives the scripted Bash call.
  if (!body.tools?.some(tool => tool.name === "Bash")) return nativeModelReply();
  requests.push({ authorization: request.headers.get("authorization"), apiKey: request.headers.get("x-api-key"), messages: body.messages });
  if (!sent) { sent = true; return nativeModelReply({ name: "Bash", input: { command, description: "Inspect the Ithaca shell." }, id: "toolu_ithaca_shell" }); }
  return nativeModelReply();
} });
const ledger = createStateLedger();
const startupView = createFixtureWorkerStartupView(brain);
const sandbox = prepareFixtureWorkerSandbox(brain, { home, profile, areas: [] });
const spawner = createWorkerSpawn(brain, { wrapper }, abort.signal, undefined, sandbox, undefined, undefined, { ledger }, undefined,
  live => { worker = live as LaunchedWorker; }, startupView);
const requireSdk = createRequire(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
const executable = requireSdk.resolve("@anthropic-ai/claude-agent-sdk-linux-x64/claude");
let nativeMatches = false, nativeEnv: Record<string, string> = {}, runtimeVersion: string | undefined;
function observeNative() {
  if (!worker) return;
  const pending = [worker.pid];
  while (pending.length) {
    const pid = pending.shift()!;
    try {
      if (readlinkSync(`/proc/${pid}/exe`) === executable) {
        nativeMatches = true;
        const values = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map(pair => {
          const position = pair.indexOf("="); return [pair.slice(0, position), pair.slice(position + 1)];
        }));
        nativeEnv = Object.fromEntries(["HOME", "CLAUDE_CONFIG_DIR", "SHELL", "BASH_ENV", "ENV", "ZDOTDIR", "SHELLOPTS", "BASHOPTS", "BASH_FUNC_git%%", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"].map(name => [name, values[name]]));
        return;
      }
      pending.push(...readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number));
    } catch { /* An exited launcher is not the selected native process. */ }
  }
}
let result: unknown;
function capture() {
  if (!worker) return;
  const state = worker.state!.root, temp = worker.turnTemp!.root;
  const read = (path: string) => existsSync(path) ? readFileSync(path, "utf8") : "";
  const snapshotDir = join(state, "shell-snapshots");
  const snapshots = fallback ? [] : existsSync(snapshotDir) ? readdirSync(snapshotDir).map(name => ({ name, content: read(join(snapshotDir, name)) })) : [];
  result = { fallback, profile: profile ?? "unprofiled", command, expectedGit, runtimeVersion, selected, nativeMatches, nativeEnv, snapshots,
    startup: read(join(temp, "brain-worker-scratch/startup.log")), debug: read(join(state, "shell-debug.log")), messages, requests,
    credentialsProjected: read(join(state, ".credentials.json")) === credential,
    xdgWritePrivate: read(join(temp, "brain-worker-home/config/voyage.txt")) === "Athena charts.\n" && !existsSync(join(home, ".config/voyage.txt")),
    hostHomeUnchanged: readFileSync(join(home, "voyage.txt"), "utf8") === "Odysseus returns to Ithaca.\n" };
}
async function captureTool() {
  // The native debug sink flushes asynchronously. Keep the live worker's
  // descriptors held until the branch receipt has reached the actual file.
  const path = join(worker!.state!.root, "shell-debug.log"), deadline = Date.now() + 5_000;
  while (!(existsSync(path) && readFileSync(path, "utf8").includes(fallback ? "EEXIST" : "Spawning shell without login (-l flag skipped)"))) {
    if (Date.now() >= deadline) throw new Error("Native shell branch diagnostic did not flush.");
    await Bun.sleep(10);
  }
  capture();
}
try {
  for await (const message of query({ prompt: "Inspect the Ithaca shell.", options: {
    cwd: brain, env: { HOME: home, ...(profile ? { CLAUDE_CONFIG_DIR: saved } : {}), PATH: "/usr/bin:/bin", SHELL: shell, LANG: "C.UTF-8",
      ...(startupEnv ? { BASH_ENV: join(home, ".bashrc"), ENV: join(home, ".bashrc"), ZDOTDIR: home,
        SHELLOPTS: "hashall:braceexpand", BASHOPTS: "extquote", "BASH_FUNC_git%%": "() { echo planted-env-function; }" } : {}),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" },
    settingSources: ["user"], permissionMode: "default", maxTurns: 3, model: "claude-sonnet-4-6", abortController: abort,
    extraArgs: { "debug-file": "/tmp/brain-worker-state/shell-debug.log" },
    stderr: text => { stderr.push(text); writeFileSync(join(root, "native-stderr.log"), stderr.join("")); },
    spawnClaudeCodeProcess: options => { selected = { command: options.command, args: options.args }; return spawner.spawn(options); },
    canUseTool: async (_name, input) => ({ behavior: "allow", updatedInput: input }),
    hooks: { PostToolUse: [{ hooks: [async input => { messages.push(input); observeNative(); await captureTool(); return {}; }] }] },
  } })) {
    if (message.type === "system" && message.subtype === "init") { runtimeVersion = message.claude_code_version; observeNative(); }
    if (message.type === "user") messages.push(message);
    if (message.type === "result" && message.is_error) throw new Error(JSON.stringify(message));
    if (result === undefined && message.type === "assistant") capture();
  }
} catch (error) { console.error("Production worker failure:", spawner.startFailure() ?? error); throw error; }
finally { clearTimeout(timer); abort.abort(); server.stop(true); try { await spawner.finish(); } finally { await startupView.cleanup(); } }
const project = join(saved, "projects", brain.replace(/[^a-zA-Z0-9]/g, "-"));
const transcriptSaved = existsSync(project) && readdirSync(project).some(name => name.endsWith(".jsonl") && readFileSync(join(project, name), "utf8").includes("toolu_ithaca_shell"));
console.log(JSON.stringify({ ...(result as object), ledgerLive: ledger.live, stateFailure: spawner.failure() ?? null, transcriptSaved,
  executableSha256: createHash("sha256").update(readFileSync(executable)).digest("hex"), namespace: readlinkSync("/proc/self/ns/net") }));
