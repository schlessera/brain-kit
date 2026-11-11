/**
 * The host side of live personas (#3617), through the real socket handlers:
 * hello disclosure for human sessions only, the Start echo, the freeze that
 * every later epoch reuses, the refusal of an outdated persona and the
 * `live_persona` push. Keyless provider double; temporary brain directory.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { createUiDb } from "../src/db/client";
import type { Principal } from "../src/db/principals";
import { createSettingsWrites } from "../src/db/settings-writes";
import type { WSContext } from "../src/ws/clients";
import { createWsHandlers } from "../src/ws/connection";
import { WsHost } from "../src/ws/host";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { createLivePersonaService, parsePersona, type LivePersonaService } from "../src/voice/personas";
import { makeFakeBackend } from "./helpers/fake-backend";
import { fakeLiveProvider } from "./helpers/live-conversation";
import { testPrincipal } from "./helpers/principal";

async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) { if (Date.now() - start > timeoutMs) throw new Error("until: timed out"); await new Promise(r => setTimeout(r, 5)); }
}

const STEWARD = "---\nschema: 1\nname: Ithaca steward\nvoices:\n  fake-live: Calypso\n---\nCalm, brief, plain words.\n";
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

function setup(options: { personas?: boolean } = {}) {
  const brain = mkdtempSync(join(tmpdir(), "odysseus-persona-host-"));
  const db = createUiDb(":memory:");
  const live = fakeLiveProvider();
  Object.assign(live.provider, { voices: [{ id: "Kore", label: "Kore" }, { id: "Calypso", label: "Calypso" }], defaultVoice: "Kore", personaInstructionBytes: 2_000 });
  const personas: LivePersonaService = createLivePersonaService({ brainPath: brain, db, settingsWrites: createSettingsWrites(db), providers: () => [live.provider] });
  const host = new WsHost({ registry: createStaticBackendRegistry([makeFakeBackend({ id: "fake" })], "fake"), catalog: createSessionCatalog(() => db),
    conversationProvider: live.provider, ...(options.personas === false ? {} : { livePersonas: personas }) });
  cleanups.push(async () => { await host.close(); db.close(); rmSync(brain, { recursive: true, force: true }); });
  const write = (text: string) => { mkdirSync(join(brain, "_voice/personas"), { recursive: true }); writeFileSync(join(brain, "_voice/personas/ithaca-steward.md"), text); };
  async function connect(principal: Principal = testPrincipal("odysseus")) {
    const handlers = createWsHandlers(host, principal);
    const sent: string[] = [];
    const ws = { send: (data: string) => sent.push(data) } as WSContext;
    await handlers.onOpen(undefined as never, ws);
    const frames = (type?: string): any[] => sent.map(s => JSON.parse(s)).filter(f => type === undefined || f.type === type);
    const send = (frame: Record<string, unknown>) => handlers.onMessage({ data: JSON.stringify(frame) } as MessageEvent, ws);
    const start = (extra: Record<string, unknown> = {}) => send({ type: "conversation_start", disclosed: host.conversations!.profile(false), requestId: crypto.randomUUID(), ...extra });
    return { frames, send, start, close: () => handlers.onClose({ code: 1000 } as CloseEvent, ws) };
  }
  return { live, personas, host, write, connect };
}

test("hello describes persona support and the selected persona to human sessions only", async () => {
  const t = setup();
  t.write(STEWARD);
  await t.personas.select(0, "ithaca-steward");
  const owner = await t.connect();
  const hello = owner.frames("server_hello")[0];
  expect(hello.conversationProfile).toMatchObject({ providerId: "fake-live", defaultVoice: "Kore", personaInstructionBytes: 2_000 });
  expect(hello.livePersona).toMatchObject({ selected: "ithaca-steward", personaRef: { id: "ithaca-steward" },
    providers: { "fake-live": { voice: "Calypso", voiceSource: "persona", overLimit: false } } });
  expect(JSON.stringify(hello)).not.toContain("Calm, brief");
  const agent = await t.connect({ ...testPrincipal("argus"), kind: "agent", authMethod: "delegated" });
  expect(agent.frames("server_hello")[0].livePersona).toBeUndefined();
});

test("Start without a persona opens exactly as before; an echo without the voice catalogue is still the same disclosure", async () => {
  const t = setup();
  const client = await t.connect();
  const { voices: _voices, defaultVoice: _default, personaInstructionBytes: _cap, ...legacy } = t.host.conversations!.profile(false);
  client.start({ disclosed: legacy });
  await until(() => t.live.sessions.length === 1);
  expect("persona" in t.live.sessions[0]!.options, "STANDARD_PASSES_NO_PERSONA").toBe(false);
});

test("the disclosed persona is read once at Start and frozen for every later epoch", async () => {
  const t = setup();
  t.write(STEWARD);
  const client = await t.connect();
  const revision = parsePersona("x", Buffer.from(STEWARD)).revision;
  client.start({ personaRef: { id: "ithaca-steward", revision } });
  await until(() => client.frames("conversation_opened").length === 1);
  expect(t.live.sessions[0]!.options.persona, "PERSONA_REACHES_PROVIDER").toEqual({ voice: "Calypso", instructions: "Calm, brief, plain words." });
  const conversationId = client.frames("conversation_opened")[0].conversationId;

  // Edited and reselected elsewhere: the running conversation's reconnect keeps its snapshot.
  t.write(STEWARD.replace("Calm", "Stormy").replace("Calypso", "Kore"));
  client.send({ type: "conversation_start", disclosed: t.host.conversations!.profile(false), conversationId, requestId: crypto.randomUUID(),
    personaRef: { id: "standard", revision: "builtin" } });
  await until(() => client.frames("conversation_opened").length === 2);
  expect(t.live.sessions[1]!.options.persona, "RECONNECT_KEEPS_FROZEN_PERSONA").toEqual({ voice: "Calypso", instructions: "Calm, brief, plain words." });
});

test("an outdated persona is refused before anything opens, after the client gets the current one", async () => {
  const t = setup();
  t.write(STEWARD);
  const client = await t.connect();
  const disclosed = client.frames("server_hello")[0].livePersona;
  t.write(STEWARD.replace("Calm", "Stormy"));
  await t.personas.select(0, "ithaca-steward");
  const pushed = client.frames("live_persona").length;
  client.start({ personaRef: { id: "ithaca-steward", revision: parsePersona("x", Buffer.from(STEWARD)).revision } });
  await until(() => client.frames("error").length === 1);
  expect(client.frames("error")[0]).toMatchObject({ code: "CONVERSATION_PERSONA_CHANGED" });
  expect(client.frames("live_persona").length).toBeGreaterThan(pushed);
  const order = client.frames().map(f => f.type);
  expect(order.lastIndexOf("live_persona"), "CURRENT_PERSONA_BEFORE_REFUSAL").toBeLessThan(order.indexOf("error"));
  expect(client.frames("live_persona").at(-1).livePersona.personaRef.revision).toBe(parsePersona("x", Buffer.from(STEWARD.replace("Calm", "Stormy"))).revision);
  expect(disclosed.personaRef.id).toBe("standard");
  expect(t.live.sessions, "NO_PROVIDER_OPENED").toHaveLength(0);
});

test("a stale voice needs the explicit default; over the cap is refused, never truncated", async () => {
  const t = setup();
  t.write(STEWARD.replace("Calypso", "Scylla"));
  const client = await t.connect();
  const revision = parsePersona("x", Buffer.from(STEWARD.replace("Calypso", "Scylla"))).revision;
  client.start({ personaRef: { id: "ithaca-steward", revision } });
  await until(() => client.frames("error").length === 1);
  expect(client.frames("error")[0].code).toBe("CONVERSATION_PERSONA_VOICE");
  client.start({ personaRef: { id: "ithaca-steward", revision, voice: "default" } });
  await until(() => t.live.sessions.length === 1);
  expect(t.live.sessions[0]!.options.persona).toEqual({ instructions: "Calm, brief, plain words." });

  const long = `---\nschema: 1\nname: Long\n---\n${"a".repeat(2_001)}\n`;
  t.write(long);
  const other = await t.connect(testPrincipal("odysseus"));
  other.start({ personaRef: { id: "ithaca-steward", revision: parsePersona("x", Buffer.from(long)).revision } });
  await until(() => other.frames("error").length === 1);
  expect(other.frames("error")[0].code).toBe("CONVERSATION_PERSONA_TOO_LONG");
  expect(t.live.sessions).toHaveLength(1);
});

test("a selection or edit is pushed to human sessions, never to agents", async () => {
  const t = setup();
  const owner = await t.connect();
  const agent = await t.connect({ ...testPrincipal("argus"), kind: "agent", authMethod: "delegated" });
  await t.personas.create({ name: "Ithaca steward", voices: {}, instructions: "Brief." });
  await t.personas.select(0, "ithaca-steward");
  await until(() => owner.frames("live_persona").some(f => f.livePersona.selected === "ithaca-steward"));
  expect(agent.frames("live_persona")).toHaveLength(0);
  owner.close();
  const before = owner.frames("live_persona").length;
  await t.personas.select(1, "standard");
  expect(owner.frames("live_persona")).toHaveLength(before);
});

test("a host without persona storage refuses a non-Standard persona", async () => {
  const t = setup({ personas: false });
  const client = await t.connect();
  expect(client.frames("server_hello")[0].livePersona).toBeUndefined();
  client.start({ personaRef: { id: "ithaca-steward", revision: "0".repeat(64) } });
  await until(() => client.frames("error").length === 1);
  expect(client.frames("error")[0].code).toBe("CONVERSATION_PERSONA");
  expect(t.live.sessions).toHaveLength(0);
});
