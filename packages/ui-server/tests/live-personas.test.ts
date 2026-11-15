/**
 * Live-conversation personas (#3617): the Markdown codec, the owner-only
 * routes, revision conflicts, the selection key and its lifecycle, and the
 * Start-time resolution. Keyless; the brain is a temporary directory.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { LIVE_PERSONA_LIMITS } from "@schlessera/brain-ui-sdk/protocol";
import type { LiveConversationProvider } from "@schlessera/brain-ui-sdk/server";
import type { AppEnv } from "../src/app-env";
import { createUiDb } from "../src/db/client";
import type { Principal } from "../src/db/principals";
import { getLivePersonaSelection, saveLivePersonaSelection } from "../src/db/settings";
import { createSettingsWrites } from "../src/db/settings-writes";
import { createVoicePersonaRoutes } from "../src/routes/voice-personas";
import {
  createLivePersonaService, normalizeInstructions, parsePersona, personaFieldsInvalid, providerStatus,
  serializePersona, standardPersona, type LivePersonaService,
} from "../src/voice/personas";
import { testPrincipal } from "./helpers/principal";

const temps: string[] = [];
afterAll(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });

const provider = (id: string, voices: string[], cap: number): LiveConversationProvider => ({
  id, voices: voices.map(voice => ({ id: voice, label: voice })), defaultVoice: voices[0], personaInstructionBytes: cap,
  capabilities: {} as LiveConversationProvider["capabilities"], disclosure: { voiceService: id, destinations: ["Fixture."] },
  open: () => { throw new Error("not opened in this test"); },
});
const GEMINI = provider("gemini-live", ["Kore", "Puck"], 6_000);
const GPT = provider("gpt-live", ["marin", "cedar"], 2_000);

const STEWARD = "---\nschema: 1\nname: Ithaca steward\nvoices:\n  gemini-live: Puck\n  gpt-live: cedar\n---\nCalm, brief, plain words. Speak like a ship's steward reporting to Odysseus:\r\nlead with what changed, then one detail.\n\n";

let brain = "";
let db: ReturnType<typeof createUiDb>;
let personas: LivePersonaService;
let app: Hono<AppEnv>;
let principal: Principal | undefined;
const dir = () => join(brain, "_voice/personas");

beforeEach(() => {
  brain = mkdtempSync(join(tmpdir(), "odysseus-personas-"));
  temps.push(brain);
  db = createUiDb(":memory:");
  personas = createLivePersonaService({ brainPath: brain, db, settingsWrites: createSettingsWrites(db), providers: () => [GEMINI, GPT] });
  principal = testPrincipal("odysseus");
  app = new Hono<AppEnv>()
    .use("*", async (c, next) => { if (principal) c.set("principal", principal); await next(); })
    .route("/api", createVoicePersonaRoutes(personas));
});

const call = (method: string, path: string, body?: unknown) =>
  app.request(`/api${path}`, { method, ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
const seed = (id: string, text: string) => { mkdirSync(dir(), { recursive: true }); writeFileSync(join(dir(), `${id}.md`), text); };

describe("persona file codec", () => {
  test("reads the authored schema, normalizing instructions and keeping unknown services", () => {
    const persona = parsePersona("ithaca-steward", Buffer.from(STEWARD.replace("gpt-live: cedar", "gpt-live: cedar\n  harbor-live: Lantern")));
    expect(persona).toMatchObject({ id: "ithaca-steward", name: "Ithaca steward", voices: { "gemini-live": "Puck", "gpt-live": "cedar", "harbor-live": "Lantern" } });
    expect(persona.instructions).toBe("Calm, brief, plain words. Speak like a ship's steward reporting to Odysseus:\nlead with what changed, then one detail.");
    expect(persona.instructionBytes).toBe(Buffer.byteLength(persona.instructions));
    expect(persona.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(persona.invalid).toBeUndefined();
  });

  test("serializes canonical bytes that read back unchanged, quoting values YAML could reinterpret", () => {
    const fields = { name: "  Penelope: weaver  ", voices: { "gpt-live": "1e3", "gemini-live": "Kore" }, instructions: "\r\nWarm.\r\n" };
    const text = serializePersona(fields);
    expect(text).toBe('---\nschema: 1\nname: "Penelope: weaver"\nvoices:\n  gemini-live: "Kore"\n  gpt-live: "1e3"\n---\nWarm.\n');
    expect(parsePersona("penelope", Buffer.from(text))).toMatchObject({ name: "Penelope: weaver", voices: { "gpt-live": "1e3" }, instructions: "Warm." });
    expect(serializePersona({ name: "Standardless", voices: {}, instructions: "" })).toBe('---\nschema: 1\nname: "Standardless"\nvoices: {}\n---\n');
  });

  test("an unusable file is listed with a fixed reason, never thrown", () => {
    expect(parsePersona("a", Buffer.from("no front matter")).invalid).toBe("front_matter");
    expect(parsePersona("a", Buffer.from("---\nschema: 2\nname: A\n---\n")).invalid).toBe("schema");
    expect(parsePersona("a", Buffer.from("---\nschema: 1\nname: \"\"\n---\n")).invalid).toBe("name");
    expect(parsePersona("a", Buffer.from("---\nschema: 1\nname: A\nvoices: [Kore]\n---\n")).invalid).toBe("voices");
    expect(parsePersona("a", Buffer.from(`---\nschema: 1\nname: A\n---\n${"é".repeat(3_001)}`)).invalid).toBe("too_long");
    expect(parsePersona("a", new Uint8Array([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe]))).toMatchObject({ invalid: "encoding" });
    expect(parsePersona("a", Buffer.from("---\n!!js/function x\n---\n")).invalid).toBe("front_matter");
  });

  test("the instruction limit is exact UTF-8 bytes of the normalized text", () => {
    const at = "é".repeat(LIVE_PERSONA_LIMITS.maxInstructionBytes / 2);
    expect(personaFieldsInvalid({ name: "A", voices: {}, instructions: `  ${at}\r\n` })).toBeNull();
    expect(personaFieldsInvalid({ name: "A", voices: {}, instructions: `${at}a` })).toBe("too_long");
    expect(normalizeInstructions(" a\r\nb\rc ")).toBe("a\nb\nc");
    expect(personaFieldsInvalid({ name: "x".repeat(41), voices: {}, instructions: "" })).toBe("name");
    expect(personaFieldsInvalid({ name: "Bell\u0007", voices: {}, instructions: "" })).toBe("name");
  });

  test("provider status names default, stale and over-limit per service", () => {
    const steward = parsePersona("s", Buffer.from(STEWARD));
    expect(providerStatus(steward, [GEMINI, GPT])).toEqual({
      "gemini-live": { voice: "Puck", voiceSource: "persona", maxInstructionBytes: 6_000, overLimit: false },
      "gpt-live": { voice: "cedar", voiceSource: "persona", maxInstructionBytes: 2_000, overLimit: false },
    });
    const stale = { ...steward, voices: { "gpt-live": "ballad-old" }, instructionBytes: 2_001 };
    expect(providerStatus(stale, [GEMINI, GPT])).toEqual({
      "gemini-live": { voice: "Kore", voiceSource: "default", maxInstructionBytes: 6_000, overLimit: false },
      "gpt-live": { voice: "marin", voiceSource: "default", staleVoice: "ballad-old", maxInstructionBytes: 2_000, overLimit: true },
    });
    expect(standardPersona([GEMINI, GPT])).toMatchObject({ id: "standard", revision: "builtin", builtIn: true, voices: { "gemini-live": "Kore", "gpt-live": "marin" }, instructions: "" });
  });
});

describe("persona routes", () => {
  test("only a human session of the brain reads or writes; others get an empty 403", async () => {
    seed("ithaca-steward", STEWARD);
    for (const denied of [{ ...testPrincipal("argus"), kind: "agent" as const, authMethod: "delegated" as const },
      { ...testPrincipal("lighthouse"), kind: "system" as const, authMethod: "ambient" as const }, undefined]) {
      principal = denied;
      for (const [method, path, body] of [["GET", "/voice/personas"], ["GET", "/voice/personas/ithaca-steward"],
        ["POST", "/voice/personas", { name: "Siren", voices: {}, instructions: "" }],
        ["PUT", "/voice/personas/ithaca-steward", { baseRevision: "x", name: "Siren", voices: {}, instructions: "" }],
        ["DELETE", "/voice/personas/ithaca-steward?baseRevision=x"], ["GET", "/settings/voice"],
        ["PUT", "/settings/voice", { persona: { value: "standard", revision: 0 } }]] as const) {
        const response = await call(method, path, body);
        expect(response.status).toBe(403);
        expect(await response.text()).toBe("");
      }
    }
    expect(readFileSync(join(dir(), "ithaca-steward.md"), "utf8")).toBe(STEWARD);
    expect(getLivePersonaSelection(db)).toEqual({ value: "standard", revision: 0 });
    principal = { ...testPrincipal("tailnet"), kind: "ambient", authMethod: "ambient" };
    expect((await call("GET", "/voice/personas")).status).toBe(200);
  });

  test("the list puts Standard first, returns no instruction text, and marks unusable files", async () => {
    seed("ithaca-steward", STEWARD);
    seed("broken", "---\nschema: 9\nname: Broken\n---\nSecret Ogygia wording.");
    writeFileSync(join(dir(), "NotAnId.md"), STEWARD);
    symlinkSync(join(dir(), "ithaca-steward.md"), join(dir(), "linked.md"));
    const response = await call("GET", "/voice/personas");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as { personas: Array<Record<string, unknown>> };
    expect(body.personas.map(p => [p.id, p.invalid ?? null])).toEqual([["standard", null], ["broken", "schema"], ["ithaca-steward", null]]);
    expect(JSON.stringify(body)).not.toContain("steward reporting");
    expect(JSON.stringify(body)).not.toContain("Ogygia");
    const one = await (await call("GET", "/voice/personas/ithaca-steward")).json() as { instructions: string };
    expect(one.instructions).toContain("steward reporting to Odysseus");
  });

  test("create, edit with the base revision, conflict, and delete", async () => {
    const created = await call("POST", "/voice/personas", { name: "Ithaca steward", voices: { "gpt-live": "cedar" }, instructions: "Brief." });
    expect(created.status).toBe(201);
    const persona = await created.json() as { id: string; revision: string };
    expect(persona.id).toBe("ithaca-steward");
    expect(readFileSync(join(dir(), "ithaca-steward.md"), "utf8")).toBe('---\nschema: 1\nname: "Ithaca steward"\nvoices:\n  gpt-live: "cedar"\n---\nBrief.\n');
    expect((await call("POST", "/voice/personas", { name: "Ithaca steward", voices: {}, instructions: "" })).status).toBe(409);
    expect(await (await call("POST", "/voice/personas", { id: "standard", name: "Standard", voices: {}, instructions: "" })).json()).toEqual({ error: "PERSONA_INVALID", reason: "name" });

    const edited = await call("PUT", "/voice/personas/ithaca-steward", { baseRevision: persona.revision, name: "Ithaca steward", voices: {}, instructions: "Briefer." });
    expect(edited.status).toBe(200);
    const next = await edited.json() as { revision: string };
    // A direct file edit (an editor, sync or an agent turn) moves the revision on.
    writeFileSync(join(dir(), "ithaca-steward.md"), STEWARD);
    const stale = await call("PUT", "/voice/personas/ithaca-steward", { baseRevision: next.revision, name: "Mine", voices: {}, instructions: "Mine." });
    expect(stale.status).toBe(409);
    const conflict = await stale.json() as { error: string; current: { instructions: string } };
    expect(conflict.error).toBe("PERSONA_CHANGED");
    expect(conflict.current.instructions).toContain("steward reporting");
    expect(readFileSync(join(dir(), "ithaca-steward.md"), "utf8")).toBe(STEWARD);

    expect((await call("DELETE", `/voice/personas/ithaca-steward?baseRevision=${next.revision}`)).status).toBe(409);
    const current = parsePersona("ithaca-steward", Buffer.from(STEWARD)).revision;
    expect((await call("DELETE", `/voice/personas/ithaca-steward?baseRevision=${current}`)).status).toBe(204);
    expect(existsSync(join(dir(), "ithaca-steward.md"))).toBe(false);
    expect((await call("PUT", "/voice/personas/standard", { baseRevision: "builtin", name: "S", voices: {}, instructions: "" })).status).toBe(409);
  });

  test("invalid input is refused with a fixed code and never echoed", async () => {
    for (const body of [{ name: "", voices: {}, instructions: "" }, { name: "A", voices: { "gpt-live": "<b>" }, instructions: "" },
      { name: "A", voices: {}, instructions: "ē".repeat(3_001) }]) {
      const response = await call("POST", "/voice/personas", body);
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).not.toContain("ē");
      expect(JSON.parse(text).error).toBe("PERSONA_INVALID");
    }
    expect(existsSync(dir())).toBe(false);
  });

  test("at most twenty usable personas; files beyond are listed but cannot be selected", async () => {
    for (let n = 0; n < LIVE_PERSONA_LIMITS.maxPersonas + 1; n++) seed(`crew-${String(n).padStart(2, "0")}`, `---\nschema: 1\nname: Crew ${String(n).padStart(2, "0")}\n---\n`);
    const list = await (await call("GET", "/voice/personas")).json() as { personas: Array<{ id: string; invalid?: string }> };
    expect(list.personas.at(-1)).toMatchObject({ id: "crew-20", invalid: "over_count" });
    expect(await (await call("POST", "/voice/personas", { name: "Another", voices: {}, instructions: "" })).json()).toEqual({ error: "PERSONA_LIMIT" });
    expect(await (await call("PUT", "/settings/voice", { persona: { value: "crew-20", revision: 0 } })).json()).toEqual({ error: "PERSONA_INVALID", reason: "over_count" });
  });
});

describe("selection", () => {
  test("its own revision, refusal of missing or invalid ids, and a stale 409 with the current value", async () => {
    seed("ithaca-steward", STEWARD);
    seed("broken", "---\nschema: 9\n---\n");
    expect(await (await call("GET", "/settings/voice")).json()).toMatchObject({ persona: { value: "standard", revision: 0 },
      livePersona: { selected: "standard", selectedMissing: false, personaRef: { id: "standard", revision: "builtin" } } });
    expect((await call("PUT", "/settings/voice", { persona: { value: "nobody", revision: 0 } })).status).toBe(400);
    expect((await call("PUT", "/settings/voice", { persona: { value: "broken", revision: 0 } })).status).toBe(400);
    const saved = await (await call("PUT", "/settings/voice", { persona: { value: "ithaca-steward", revision: 0 } })).json() as { persona: unknown; livePersona: { personaRef: unknown; providers: unknown } };
    expect(saved.persona).toEqual({ value: "ithaca-steward", revision: 1 });
    expect(saved.livePersona.personaRef).toEqual({ id: "ithaca-steward", revision: parsePersona("x", Buffer.from(STEWARD)).revision });
    expect(saved.livePersona.providers).toMatchObject({ "gpt-live": { voice: "cedar", overLimit: false } });
    const stale = await call("PUT", "/settings/voice", { persona: { value: "standard", revision: 0 } });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "LIVE_PERSONA_CHANGED", persona: { value: "ithaca-steward", revision: 1 } });
  });

  test("a corrupt row reads as Standard; compare-and-set saves nothing when stale", () => {
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('voice.live.persona', '\"steward\"', 0)").run();
    expect(getLivePersonaSelection(db)).toEqual({ value: "standard", revision: 0 });
    expect(saveLivePersonaSelection(db, 5, "x").saved).toBe(false);
    expect(saveLivePersonaSelection(db, 0, "ithaca-steward")).toEqual({ saved: true, current: { value: "ithaca-steward", revision: 1 } });
  });

  test("deleting the selected persona resets the selection to Standard before the file goes", async () => {
    seed("ithaca-steward", STEWARD);
    await call("PUT", "/settings/voice", { persona: { value: "ithaca-steward", revision: 0 } });
    const order: string[] = [];
    const writes = createSettingsWrites(db);
    const watched = createLivePersonaService({ brainPath: brain, db, providers: () => [GPT],
      settingsWrites: { saveLivePersonaSelection: async (expected, value) => {
        order.push(`select ${value} file=${existsSync(join(dir(), "ithaca-steward.md"))}`);
        return writes.saveLivePersonaSelection(expected, value);
      } } });
    await watched.remove("ithaca-steward", parsePersona("x", Buffer.from(STEWARD)).revision);
    expect(order).toEqual(["select standard file=true"]);
    expect(getLivePersonaSelection(db)).toEqual({ value: "standard", revision: 2 });
    expect(existsSync(join(dir(), "ithaca-steward.md"))).toBe(false);
  });

  test("a selected file removed outside Settings resolves to Standard and says so", async () => {
    seed("ithaca-steward", STEWARD);
    await call("PUT", "/settings/voice", { persona: { value: "ithaca-steward", revision: 0 } });
    rmSync(join(dir(), "ithaca-steward.md"));
    const status = await personas.status();
    expect(status).toMatchObject({ selected: "ithaca-steward", selectedMissing: true, selectedInvalid: false, personaRef: { id: "standard", revision: "builtin" } });
  });

  test("writes and selection changes reach subscribers with a fresh status", async () => {
    const seen: string[] = [];
    personas.subscribe(status => seen.push(`${status.selected}:${status.persona.name}`));
    const created = await personas.create({ name: "Ithaca steward", voices: {}, instructions: "Brief." });
    await personas.select(0, created.id);
    expect(seen).toEqual(["standard:Standard", "ithaca-steward:Ithaca steward"]);
  });
});

describe("Start resolution", () => {
  const revision = () => parsePersona("x", Buffer.from(STEWARD)).revision;

  test("no ref or Standard opens exactly as before personas", async () => {
    expect(await personas.resolveStart(undefined, GPT)).toEqual({ ok: true, snapshot: { id: "standard", revision: "builtin", instructions: "" } });
    expect(await personas.resolveStart({ id: "standard", revision: "builtin" }, GPT)).toMatchObject({ ok: true, snapshot: { id: "standard" } });
  });

  test("the disclosed revision freezes voice and instructions; a changed file is refused", async () => {
    seed("ithaca-steward", STEWARD);
    expect(await personas.resolveStart({ id: "ithaca-steward", revision: revision() }, GPT)).toEqual({ ok: true,
      snapshot: { id: "ithaca-steward", revision: revision(), voice: "cedar", instructions: parsePersona("x", Buffer.from(STEWARD)).instructions } });
    const pushed: string[] = [];
    personas.subscribe(status => pushed.push(status.personaRef.revision));
    writeFileSync(join(dir(), "ithaca-steward.md"), STEWARD.replace("Calm", "Stormy"));
    const refused = await personas.resolveStart({ id: "ithaca-steward", revision: revision() }, GPT);
    expect(refused).toMatchObject({ ok: false, code: "CONVERSATION_PERSONA_CHANGED" });
    expect(pushed).toHaveLength(1);
    expect(await personas.resolveStart({ id: "ithaca-steward", revision: "0".repeat(64) }, GPT)).toMatchObject({ ok: false, code: "CONVERSATION_PERSONA_CHANGED" });
  });

  test("over a service's cap is refused, never truncated; the other service accepts it", async () => {
    seed("long", `---\nschema: 1\nname: Long\n---\n${"a".repeat(2_001)}`);
    const long = parsePersona("long", readFileSync(join(dir(), "long.md")));
    expect(await personas.resolveStart({ id: "long", revision: long.revision }, GPT)).toMatchObject({ ok: false, code: "CONVERSATION_PERSONA_TOO_LONG" });
    const accepted = await personas.resolveStart({ id: "long", revision: long.revision }, GEMINI);
    expect(accepted.ok && accepted.snapshot.instructions.length).toBe(2_001);
  });

  test("a stale saved voice needs the explicit one-time default; an omitted voice uses the default", async () => {
    seed("old", "---\nschema: 1\nname: Old\nvoices:\n  gpt-live: retired\n---\nBrief.");
    const old = parsePersona("old", readFileSync(join(dir(), "old.md")));
    expect(await personas.resolveStart({ id: "old", revision: old.revision }, GPT)).toMatchObject({ ok: false, code: "CONVERSATION_PERSONA_VOICE" });
    expect(await personas.resolveStart({ id: "old", revision: old.revision, voice: "default" }, GPT)).toEqual({ ok: true, snapshot: { id: "old", revision: old.revision, instructions: "Brief." } });
    expect(await personas.resolveStart({ id: "old", revision: old.revision }, GEMINI)).toEqual({ ok: true, snapshot: { id: "old", revision: old.revision, instructions: "Brief." } });
  });

  test("an invalid file and a service without persona support are refused", async () => {
    seed("broken", "---\nschema: 9\n---\n");
    const broken = parsePersona("broken", readFileSync(join(dir(), "broken.md")));
    expect(await personas.resolveStart({ id: "broken", revision: broken.revision }, GPT)).toMatchObject({ ok: false, code: "CONVERSATION_PERSONA" });
    seed("ithaca-steward", STEWARD);
    const plain = { ...GPT, voices: undefined, defaultVoice: undefined, personaInstructionBytes: undefined };
    expect(await personas.resolveStart({ id: "ithaca-steward", revision: revision() }, plain)).toMatchObject({ ok: false, code: "CONVERSATION_PERSONA" });
  });
});

describe("containment", () => {
  test("a linked persona directory is never followed or written through", async () => {
    const outside = mkdtempSync(join(tmpdir(), "odysseus-outside-"));
    temps.push(outside);
    mkdirSync(join(brain, "_voice"));
    symlinkSync(outside, join(brain, "_voice/personas"));
    writeFileSync(join(outside, "sirens.md"), STEWARD);
    expect((await call("GET", "/voice/personas")).status).toBe(503);
    expect((await call("POST", "/voice/personas", { name: "Sirens", voices: {}, instructions: "Sing." })).status).toBe(503);
    expect(existsSync(join(outside, "sirens-1.md"))).toBe(false);
    expect(readFileSync(join(outside, "sirens.md"), "utf8")).toBe(STEWARD);
  });
});
