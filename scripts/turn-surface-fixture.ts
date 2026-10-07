/** Disposable fictional project. No SDK query or provider transport. */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ClassificationAnswers, ClassificationRequest } from "@schlessera/brain-ui-sdk/internal";
import type { BackendBridge, StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { discoverSkills } from "../packages/core/src/lib/skills/discover.js";
import { claudeEmitter } from "../packages/core/src/lib/skills/emitters/claude.js";
import { assembleTurn, connectSurface, type SkillEntry, type Peer } from "./turn-surface-routing.js";
import cases from "./fixtures/turn-surface-cases.json";
import { DEFAULT_ALLOWED_TOOLS } from "../packages/ui-backend-claude/src/tool-policy.js";
import corpusConfig from "../packages/core/fixtures/corpus/brain.config.js";

export const FROZEN_CASES = cases;
export function createFixture(control?: { corpus?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "turn-surface-fixture-"));
  writeFileSync(join(root, "brain.config.json"), JSON.stringify({ profile: { name: "Odysseus" } }));
  mkdirSync(join(root, "me"));
  writeFileSync(join(root, "me/identity.md"), "---\ntitle: Odysseus\ntype: identity\n---\n\nOdysseus is preparing the next voyage.\n");
  if (control?.corpus) {
    cpSync(join(import.meta.dir, "../packages/core/fixtures/corpus"), root, { recursive: true });
    // The copied TS config imports a workspace package that is deliberately
    // absent from this outside-checkout fixture. The same config object is
    // supplied as literal data; document/skill content remains unchanged.
    rmSync(join(root, "brain.config.ts"));
    writeFileSync(join(root, "brain.config.json"), JSON.stringify(corpusConfig));
    writeFileSync(join(root, "CLAUDE.md"), "This is the fictional Odysseus notebook. Its current story date is 2026-07-12, independent of the runtime calendar. Odysseus is alone on Ogygia; his crew did not survive Thrinacia. Follow an existing project skill when the user requests its written procedure. Do not save drafts, change notebook files or settings, or invent completed construction. Use the notebook for facts about Odysseus; general explanations may be answered in prose.\n");
  }
  const restoreSkills = () => { for (const skill of cases.skills) {
    const dir = join(root, ".agents/skills", skill.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\nConsult the voyage notebook before recording a decision.\n`);
  } };
  restoreSkills();
  const discover = () => discoverSkills({ root, modules: [] }, { coreSkillsDir: join(root, "no-core-skills") });
  const discovered = discover();
  if (discovered.warnings.length || discovered.skills.length !== cases.skills.length) throw new Error("fixture skill discovery failed");
  claudeEmitter.emit(discovered.skills, root);
  return {
    root, skills: discovered.skills.map(({ name, description }) => ({ name, description })) satisfies SkillEntry[],
    restoreSkills() { restoreSkills(); claudeEmitter.emit(discover().skills, root); },
    skillFiles: () => Object.fromEntries(readdirSync(join(root, ".claude/skills")).sort().map(name => [name, readFileSync(join(root, ".claude/skills", name, "SKILL.md"), "utf8")])),
    pruneSkills(names: readonly string[]) {
      // Sources and emitted entries are removed only in this disposable root.
      // Rejected skills cannot be manually read from their former source.
      for (const skill of discovered.skills) if (!names.includes(skill.name)) rmSync(skill.dir, { recursive: true });
      claudeEmitter.emit(discover().skills, root);
    },
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

export async function fixtureTurn(root: string, prompt: string, posture: "normal" | "no-grant" | "autonomous" = "normal", attachments?: StartTurnRequest["attachments"], control?: {
  productionDefaults?: boolean;
  bridge?: Partial<BackendBridge>;
}) {
  const never = async () => { throw new Error("unexpected host interaction in fixture"); };
  let askUserCalls = 0;
  const bridge: BackendBridge = { emit: () => {}, checkpointPermission: () => {}, requestPermission: never,
    askUser: async () => { askUserCalls++; return { answers: { Harbour: "Ithaca" } }; },
    askUserList: never, askUserRank: never, askUserForm: never,
    getLocation: never, requestMask: never, queryActivity: never, ...control?.bridge };
  const abortController = new AbortController();
  const req: StartTurnRequest = {
    prompt, attachments, bridge, turnBudgetMs: 180_000, noGrantSurface: posture !== "normal",
    enforceAllowedTools: posture !== "normal", signal: abortController.signal,
    ...(posture === "autonomous" ? { autonomous: { origin: "autonomous" as const, persistence: "none" as const, allowedTools: ["Read"], systemPromptAppend: "Use only the server-authorized tools." } } : {}),
  };
  const input: Parameters<typeof assembleTurn>[0] = { backend: { brainPath: root }, req,
    profile: { id: "fixture", label: "Fixture", requiredEnvKeys: [], billing: "subscription", buildEnv: () => ({}) },
    abortController, allowedTools: posture === "autonomous" ? ["Read"] : control?.productionDefaults ? DEFAULT_ALLOWED_TOOLS : ["Read", "Bash"],
    confirmPatterns: [/rm/], turnLock: { acquire: async () => {}, release: () => {} } as never, log: () => {},
  };
  const turn = assembleTurn(input);
  // Inventory owns a separate real production instance. It must not occupy
  // the returned turn's transport before the SDK is able to connect to it.
  const inventoryTurn = assembleTurn(input);
  const server = inventoryTurn.options.mcpServers?.["brain-ui"];
  if (!server || server.type !== "sdk") throw new Error("production assembly did not supply its bridge server");
  const peer = await connectSurface("brain-ui", server);
  if (!peer.tools.length) throw new Error("production bridge listed no tools");
  return { turn, peer, askUserCalls: () => askUserCalls, close: async () => {
    await peer.client.close(); await server.instance.close();
    const original = turn.options.mcpServers?.["brain-ui"];
    if (original?.type === "sdk") await original.instance.close();
  } };
}

/** Version files beside the entry resolved from the backend, not root hoisting. */
export function installedRuntime() {
  const dir = dirname(Bun.resolveSync("@anthropic-ai/claude-agent-sdk", join(import.meta.dir, "../packages/ui-backend-claude/src")));
  return { agentSdk: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version as string,
    claudeCode: JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).version as string };
}

export async function connectBrainSurface(root: string): Promise<Peer> {
  const fixtureHome = join(root, ".fixture-home");
  mkdirSync(fixtureHome, { recursive: true });
  const client = new Client({ name: "turn-surface-core", version: "0.1.0" });
  // Exact environment: no account discovery, ambient provider keys or model
  // commands. This is the real stdio MCP server, not a Claude process.
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(import.meta.dir, "../packages/core/src/mcp-server.ts")], cwd: root,
    env: { BRAIN_ROOT: root, HOME: fixtureHome, PATH: dirname(process.execPath) }, stderr: "pipe" });
  transport.stderr?.on("data", () => {});
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    if (!tools.length) throw new Error("actual core server listed no tools");
    return { client, tools: tools.map(tool => ({ ...tool, id: `mcp__brain__${tool.name}`, serverName: "brain" })) };
  } catch (error) { await client.close(); throw error; }
}

/** Scripted answers are test inputs, never a model-quality observation. */
export function scriptedAnswers(request: ClassificationRequest, tool: string | null, skill: string | null): ClassificationAnswers {
  const answers: ClassificationAnswers = {};
  for (const [kind, picked] of [["tool", tool], ["skill", skill]] as const) {
    const question = request.questions[kind];
    if (question.type !== "choice") throw new Error("expected choice question");
    const winner = picked ?? Object.keys(question.criteria)[0];
    answers[kind] = { type: "choice", choice: winner, confidence: 0.99, probabilities: { [winner]: 0.99 } };
    answers[`needs_${kind}`] = { type: "noul", noul: picked ? 0.99 : 0.01 };
    for (const name of Object.keys(question.criteria)) answers[`fits_${kind}:${name}`] = { type: "noul", noul: name === winner ? 0.99 : 0.01 };
  }
  return answers;
}
