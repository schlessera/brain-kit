/**
 * Live-conversation persona routes (#3617). Reads need a human session of the
 * brain; writes need its owner. Agent, worker and delegated principals get an
 * empty 403. Responses and errors carry fixed codes only, never persona text
 * beyond the single-persona read that returns it as data.
 */
import { Hono, type Context } from "hono";
import type {
  LivePersonaListResponse,
  VoiceLiveSettings,
  VoiceSettingsResponse,
} from "@schlessera/brain-ui-sdk/protocol";
import { isLiveSettingsWriter } from "./live-settings.js";
import type { AppEnv } from "../app-env.js";
import type { Principal } from "../db/principals.js";
import { PERSONA_ID, PersonaError, type LivePersonaService, type LivePersonaWriteFields } from "../voice/personas.js";

/** A human session of this brain: its owner, or the single user of an ambient-auth host. */
function human(principal: Principal | undefined): boolean {
  return principal !== undefined && principal.authMethod !== "delegated" && (principal.kind === "owner" || principal.kind === "ambient");
}

const refuse = (c: Context<AppEnv>) => c.body(null, 403);

function failed(c: Context<AppEnv>, error: unknown) {
  if (error instanceof PersonaError) {
    return c.json({ error: error.code, ...(error.reason ? { reason: error.reason } : {}) }, error.status);
  }
  return c.json({ error: "PERSONA_STORAGE" }, 503);
}

function fields(body: unknown): LivePersonaWriteFields | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { name, voices, instructions } = body as Record<string, unknown>;
  if (typeof name !== "string" || typeof instructions !== "string" || !voices || typeof voices !== "object" || Array.isArray(voices)) return null;
  // Bounded before any validation work: an oversized body is refused as too long.
  if (name.length > 400 || instructions.length > 64_000) return null;
  return { name, voices: voices as Record<string, string>, instructions };
}

/**
 * The live-service default (#3616), the other group of `/settings/voice`, with
 * its own revision. Absent: the route reports nothing saved and refuses a write.
 */
interface LiveDefaultSettings {
  read(): VoiceLiveSettings;
  save(revision: number, defaultProvider: string | null): Promise<{ saved: boolean; current: VoiceLiveSettings }> | { saved: boolean; current: VoiceLiveSettings };
  /** Registered at boot; nothing probes a credential. */
  known(id: string): boolean;
  /** After a save: tell open connections. Never retargets a running conversation. */
  changed?(): void;
}

const NO_LIVE_DEFAULT: LiveDefaultSettings = { read: () => ({ defaultProvider: null, revision: 0 }), save: () => ({ saved: false, current: { defaultProvider: null, revision: 0 } }), known: () => false };

export function createVoicePersonaRoutes(personas: LivePersonaService, live: LiveDefaultSettings = NO_LIVE_DEFAULT): Hono<AppEnv> {
  const settings = async (): Promise<VoiceSettingsResponse> => ({ ...live.read(), persona: personas.selection(), livePersona: await personas.status() });
  return new Hono<AppEnv>()
    .get("/voice/personas", async (c) => {
      c.header("Cache-Control", "no-store");
      if (!human(c.get("principal"))) return refuse(c);
      try {
        const body: LivePersonaListResponse = { personas: await personas.list() };
        return c.json(body);
      } catch (error) { return failed(c, error); }
    })
    .get("/voice/personas/:id", async (c) => {
      c.header("Cache-Control", "no-store");
      if (!human(c.get("principal"))) return refuse(c);
      try {
        const persona = await personas.read(c.req.param("id"));
        if (!persona) return c.json({ error: "PERSONA_NOT_FOUND" }, 404);
        c.header("ETag", `"${persona.revision}"`);
        return c.json(persona);
      } catch (error) { return failed(c, error); }
    })
    .post("/voice/personas", async (c) => {
      c.header("Cache-Control", "no-store");
      if (!human(c.get("principal"))) return refuse(c);
      const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
      const input = fields(body);
      if (!input || (body!.id !== undefined && (typeof body!.id !== "string" || !PERSONA_ID.test(body!.id)))) return c.json({ error: "PERSONA_INVALID" }, 400);
      try {
        const created = await personas.create({ ...input, ...(typeof body!.id === "string" ? { id: body!.id } : {}) });
        return c.json(created, 201);
      } catch (error) { return failed(c, error); }
    })
    .put("/voice/personas/:id", async (c) => {
      c.header("Cache-Control", "no-store");
      if (!human(c.get("principal"))) return refuse(c);
      const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
      const input = fields(body);
      if (!input || typeof body!.baseRevision !== "string" || !body!.baseRevision) return c.json({ error: "PERSONA_INVALID" }, 400);
      try {
        return c.json(await personas.update(c.req.param("id"), body!.baseRevision, input));
      } catch (error) {
        if (error instanceof PersonaError && error.code === "PERSONA_CHANGED") {
          // The editor keeps the user's text and offers the newer version.
          const current = await personas.read(c.req.param("id")).catch(() => null);
          return c.json({ error: "PERSONA_CHANGED", ...(current ? { current } : {}) }, 409);
        }
        return failed(c, error);
      }
    })
    .delete("/voice/personas/:id", async (c) => {
      c.header("Cache-Control", "no-store");
      if (!human(c.get("principal"))) return refuse(c);
      const base = c.req.query("baseRevision");
      if (!base) return c.json({ error: "PERSONA_INVALID" }, 400);
      try {
        await personas.remove(c.req.param("id"), base);
        return c.body(null, 204);
      } catch (error) { return failed(c, error); }
    })
    .get("/settings/voice", async (c) => {
      c.header("Cache-Control", "no-store");
      if (!human(c.get("principal"))) return refuse(c);
      try {
        return c.json(await settings());
      } catch (error) { return failed(c, error); }
    })
    .put("/settings/voice", async (c) => {
      c.header("Cache-Control", "no-store");
      // The owner-only write guard (#3616 §3), checked before the body is read.
      if (!human(c.get("principal")) || !isLiveSettingsWriter(c.get("principal"), Date.now())) return refuse(c);
      const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
      if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "VOICE_SETTINGS_INVALID" }, 400);
      if ("defaultProvider" in body || "revision" in body) {
        const { defaultProvider, revision } = body;
        if (!(defaultProvider === null || typeof defaultProvider === "string" && defaultProvider.length > 0) ||
            typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
          return c.json({ error: "LIVE_SETTINGS_INVALID", message: "Send { defaultProvider: string | null, revision: number }." }, 400);
        }
        if (defaultProvider !== null && !live.known(defaultProvider)) {
          return c.json({ error: "LIVE_PROVIDER_UNKNOWN", message: "That live service isn't available on this host." }, 400);
        }
        const result = await live.save(revision, defaultProvider);
        if (!result.saved) return c.json({ error: "LIVE_SETTINGS_CHANGED", message: "Changed on another device.", current: result.current }, 409);
        live.changed?.();
      }
      const persona = body.persona as Record<string, unknown> | undefined;
      if (persona === undefined) return c.json(await settings());
      if (!persona || typeof persona !== "object" || typeof persona.value !== "string" || !PERSONA_ID.test(persona.value) ||
          typeof persona.revision !== "number" || !Number.isSafeInteger(persona.revision) || persona.revision < 0) {
        return c.json({ error: "VOICE_SETTINGS_INVALID" }, 400);
      }
      try {
        const result = await personas.select(persona.revision, persona.value);
        const livePersona = await personas.status();
        if (!result.saved) return c.json({ error: "LIVE_PERSONA_CHANGED", persona: result.current, livePersona }, 409);
        return c.json({ ...live.read(), persona: result.current, livePersona } satisfies VoiceSettingsResponse);
      } catch (error) { return failed(c, error); }
    });
}
