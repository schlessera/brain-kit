import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendRequestError, createKeyedLock, type AgentBackend, type StartTurnRequest } from "@schlessera/brain-ui-sdk/server";

import { createBrainAccess } from "../src/brain-access";
import { discoversPiExtensions, gateUnsupportedConfiguration, inspectPiExtensions, type PiExtensionInspection } from "../src/extension-inspection";
import { backendModule } from "../src/module";
import { createSessionResources } from "../src/session-resources";
import { toolLockFromKeyed } from "../src/tools";

/**
 * #3658: a known-unsupported extension set is found before admission, never
 * by running it, and the curated default keeps skills and context files.
 */
let root: string, brain: string, agent: string, sentinel: string;
const restore: Array<() => void> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "odysseus-pi-extensions-"));
  brain = join(root, "ithaca"); agent = join(root, "agent"); sentinel = join(root, "extension-ran");
  mkdirSync(join(brain, ".pi/extensions"), { recursive: true });
  mkdirSync(join(brain, ".pi/skills/chart-the-voyage"), { recursive: true });
  mkdirSync(join(agent, "extensions"), { recursive: true });
  // Importing either extension leaves a sentinel; nothing here may import it.
  const body = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "ran");\nexport default function () {}\n`;
  writeFileSync(join(brain, ".pi/extensions/loom.ts"), body);
  writeFileSync(join(agent, "extensions/aeolus.ts"), body);
  writeFileSync(join(brain, "AGENTS.md"), "Penelope keeps the loom until Odysseus returns.\n");
  writeFileSync(join(brain, ".pi/skills/chart-the-voyage/SKILL.md"),
    "---\nname: chart-the-voyage\ndescription: Chart the route from Troy to Ithaca.\n---\nFollow the stars.\n");
  for (const [key, value] of [["HOME", join(root, "home")], ["PI_CODING_AGENT_DIR", agent]] as const) {
    const previous = process.env[key];
    process.env[key] = value;
    restore.push(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
});
afterEach(() => {
  for (const undo of restore.splice(0)) undo();
  rmSync(root, { recursive: true, force: true });
});

/** A configured package that is not installed: the loader would try to install it. */
const absentPackage = () => writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: ["npm:odysseus-absent-extension@1.0.0"] }));

test("inspection names every extension discovery would load without running or installing any", async () => {
  absentPackage();
  const inspection = await inspectPiExtensions(brain, agent);
  expect(inspection.ok, "PI_INSPECTION_OK").toBe(true);
  const findings = inspection.ok ? inspection.findings : [];
  expect(findings.map(finding => [finding.path, finding.scope, finding.missing ?? false]), "PI_INSPECTION_FINDINGS").toEqual([
    [join(brain, ".pi/extensions/loom.ts"), "project", false],
    [join(agent, "extensions/aeolus.ts"), "user", false],
    ["npm:odysseus-absent-extension@1.0.0", "configured", true],
  ]);
  expect(existsSync(sentinel), "PI_INSPECTION_RAN_NO_EXTENSION").toBe(false);
  expect(existsSync(join(agent, "npm")), "PI_INSPECTION_INSTALLED_NOTHING").toBe(false);
});

test("the curated default loads no extension and keeps skills and context files", async () => {
  expect(discoversPiExtensions({}), "PI_DEFAULT_IS_CURATED").toBe(false);
  expect(discoversPiExtensions({ loadExtensions: true }), "PI_TRUE_DISCOVERS").toBe(true);
  const resources = createSessionResources({
    backend: { brainPath: brain }, brain: createBrainAccess(brain), lock: toolLockFromKeyed(createKeyedLock()),
    allowedTools: new Set(), confirmPatterns: [], loadExtensions: discoversPiExtensions({}), managedToolSafety: true,
  });
  const caps = { askUser: false, askUserList: false, askUserRank: false, location: false, activity: false, mask: false };
  const { loader } = await resources.build(resources.buildToolkit(caps), { caps });
  const loaded = loader.getExtensions();
  expect([loaded.extensions.length, loaded.errors.length], "PI_CURATED_LOADS_NO_EXTENSION").toEqual([0, 0]);
  expect(existsSync(sentinel), "PI_CURATED_RAN_NO_EXTENSION").toBe(false);
  expect(loader.getSkills().skills.map(skill => skill.name), "PI_CURATED_KEEPS_SKILLS").toContain("chart-the-voyage");
  expect(loader.getAgentsFiles().agentsFiles.map(file => file.content), "PI_CURATED_KEEPS_CONTEXT").toContainEqual(expect.stringContaining("Penelope keeps the loom"));
});

/** A stand-in backend that records whether a turn reached it. */
function voyageBackend() {
  const started: StartTurnRequest[] = [];
  const backend = {
    id: "pi", capabilities: {},
    listProfiles: () => [{ id: "argo", label: "Argo" }],
    async startTurn(req: StartTurnRequest) { started.push(req); },
  } as unknown as AgentBackend;
  return { backend, started };
}

function turn(extra: Partial<StartTurnRequest> = {}) {
  const unavailable: unknown[] = [];
  const req = { prompt: "Chart the route to Ithaca", signal: new AbortController().signal,
    bridge: { emit() {}, requestPermission: async () => ({ behavior: "allow" as const }),
      inputSafety: { async ready() {}, async begin() {}, async result() {}, async unavailable() { unavailable.push(true); throw new Error("latched"); } } },
    ...extra } as unknown as StartTurnRequest;
  return { req, unavailable };
}

test("with discovery opted in, an unsupported extension set makes Pi unavailable and refuses before admission", async () => {
  const { backend, started } = voyageBackend();
  const gated = gateUnsupportedConfiguration(backend, brain, true);
  expect(await gated.listProfiles(), "PI_GATED_RUNS_NO_PROFILE").toEqual([]);
  expect(await gated.listUnavailableProfiles!(), "PI_GATED_REPORTS_UNAVAILABLE").toEqual([{ id: "argo", label: "Argo", reason: "unsupported-configuration" }]);
  const { req, unavailable } = turn();
  const refusal = await gated.startTurn(req).then(() => undefined, (error: unknown) => error);
  expect(refusal, "PI_GATED_REFUSES_AT_ADMISSION").toBeInstanceOf(BackendRequestError);
  expect(String((refusal as Error).message), "PI_GATED_NAMES_THE_SETTING").toContain("BRAIN_UI_PI_EXTENSIONS=curated");
  expect(String((refusal as Error).message), "PI_GATED_NAMES_THE_EXTENSION").toContain("loom.ts");
  expect([started.length, unavailable.length], "PI_GATED_NEVER_REACHES_WORKER_OR_RECORDER").toEqual([0, 0]);
  expect(existsSync(sentinel), "PI_GATED_RAN_NO_EXTENSION").toBe(false);
});

test("the gate passes a restricted autonomous turn, an extension-free set, and refuses an inspection failure", async () => {
  const { backend, started } = voyageBackend();
  await gateUnsupportedConfiguration(backend, brain, true).startTurn(turn({ autonomous: { containment: "restricted" } } as Partial<StartTurnRequest>).req);
  expect(started.length, "PI_GATE_PASSES_RESTRICTED").toBe(1);

  const clean = gateUnsupportedConfiguration(backend, brain, true, async () => ({ ok: true, findings: [] }));
  expect(await clean.listProfiles(), "PI_CLEAN_LISTS_PROFILES").toEqual([{ id: "argo", label: "Argo" }]);
  expect(await clean.listUnavailableProfiles!(), "PI_CLEAN_REPORTS_NONE").toEqual([]);
  await clean.startTurn(turn().req);
  expect(started.length, "PI_CLEAN_RUNS").toBe(2);

  const failed: PiExtensionInspection = { ok: false, error: "settings unreadable" };
  const unknown = gateUnsupportedConfiguration(backend, brain, true, async () => failed);
  expect(await unknown.listProfiles(), "PI_UNKNOWN_RUNS_NO_PROFILE").toEqual([]);
  await expect(unknown.startTurn(turn().req), "PI_UNKNOWN_REFUSES").rejects.toBeInstanceOf(BackendRequestError);
  expect(started.length, "PI_UNKNOWN_NEVER_RUNS").toBe(2);
});

async function hosted(config: Record<string, unknown>) {
  const logs: string[] = [];
  const profiles = [{ id: "argo", label: "Argo", vendor: "anthropic", model: "claude-sonnet-4-6" }];
  const context = { brainPath: brain, config, profiles, confirmBashPatterns: null, settings: {},
    log: (_level: string, message: string) => { logs.push(message); } } as never;
  const report = await backendModule.probeRuntime!(context);
  const resolved = await backendModule.resolveFromEnv(context);
  if (!resolved.ok) throw resolved.error;
  return { report, logs, backend: resolved.value.backend };
}

test("hosted curated default discloses inactive extensions at startup and keeps Pi available", async () => {
  const { report, logs, backend } = await hosted({});
  expect(report.sdk?.name, "PI_PROBE_STILL_REPORTS_SDK").toBe("@earendil-works/pi-coding-agent");
  expect(logs.some(line => line.includes("installed but inactive") && line.includes("loom.ts") && line.includes("aeolus.ts")), "PI_STARTUP_NAMES_INACTIVE").toBe(true);
  expect(await backend.listUnavailableProfiles!(), "PI_CURATED_REPORTS_NONE").toEqual([]);
  expect((await backend.listProfiles()).map(profile => profile.id), "PI_CURATED_LISTS_PROFILES").toEqual(["argo"]);
  expect(logs.some(line => line.startsWith("pi profiles are unavailable")), "PI_CURATED_NOT_BLOCKED").toBe(false);
  expect(existsSync(sentinel), "PI_STARTUP_RAN_NO_EXTENSION").toBe(false);
});

test("hosted discover with an installed extension reports Pi unavailable without refusing boot", async () => {
  const { logs, backend } = await hosted({ piExtensions: "discover" });
  expect(logs.some(line => line.startsWith("pi profiles are unavailable") && line.includes("loom.ts")), "PI_STARTUP_NAMES_UNAVAILABLE").toBe(true);
  expect(await backend.listProfiles(), "PI_DISCOVER_RUNS_NO_PROFILE").toEqual([]);
  await expect(backend.startTurn(turn().req), "PI_DISCOVER_REFUSES").rejects.toBeInstanceOf(BackendRequestError);
  expect(existsSync(sentinel), "PI_DISCOVER_RAN_NO_EXTENSION").toBe(false);
});

test("hosted curated default blocks Pi only for a configured package that is not installed", async () => {
  absentPackage();
  const { logs, backend } = await hosted({});
  expect(logs.some(line => line.startsWith("pi profiles are unavailable") && line.includes("not installed") && line.includes("odysseus-absent-extension")), "PI_STARTUP_NAMES_MISSING_PACKAGE").toBe(true);
  expect(await backend.listUnavailableProfiles!(), "PI_MISSING_PACKAGE_UNAVAILABLE").toEqual([{ id: "argo", label: "Argo", reason: "unsupported-configuration" }]);
  expect(await backend.listProfiles(), "PI_MISSING_PACKAGE_RUNS_NO_PROFILE").toEqual([]);
  const refusal = await backend.startTurn(turn().req).then(() => undefined, (error: unknown) => error);
  expect(refusal, "PI_MISSING_PACKAGE_REFUSES").toBeInstanceOf(BackendRequestError);
  expect(String((refusal as Error).message), "PI_MISSING_PACKAGE_MESSAGE").toContain("not installed");
  expect(existsSync(join(agent, "npm")), "PI_MISSING_PACKAGE_INSTALLED_NOTHING").toBe(false);
});

test("in the curated default only a missing package or an inspection failure blocks the gate", async () => {
  const { backend, started } = voyageBackend();
  const installed = gateUnsupportedConfiguration(backend, brain, false);
  expect(await installed.listUnavailableProfiles!(), "PI_CURATED_INSTALLED_PASSES").toEqual([]);
  await installed.startTurn(turn().req);
  expect(started.length, "PI_CURATED_INSTALLED_RUNS").toBe(1);
  const unknown = gateUnsupportedConfiguration(backend, brain, false, async () => ({ ok: false, error: "settings unreadable" }));
  await expect(unknown.startTurn(turn().req), "PI_CURATED_UNKNOWN_REFUSES").rejects.toBeInstanceOf(BackendRequestError);
  expect(started.length, "PI_CURATED_UNKNOWN_NEVER_RUNS").toBe(1);
});
