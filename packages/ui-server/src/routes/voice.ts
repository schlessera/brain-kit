import type { Database } from "bun:sqlite";
import type { AppEnv } from "../app-env.js";
import { getDictationSettings } from "../db/settings.js";
import type { SettingsWrites } from "../db/settings-writes.js";
import { Hono } from "hono";
import type {
  VoiceKeytermsResponse,
  VoiceTokenResponse,
  VoiceSessionResponse,
  VoiceSessionRequest,
} from "@schlessera/brain-ui-sdk/protocol";
import type { VoiceConfig } from "../config/env.js";
import type { SpeechSession } from "@schlessera/brain-ui-sdk/server";
import { mintDeepgramToken } from "../voice/deepgram-token.js";
import { getKeyterms, type KeytermSettings } from "../voice/keyterm-builder.js";
import { type SpeechProviderRegistry, speechCapabilities } from "../voice/speech-providers.js";

interface VoiceRoutesDeps {
  voice: VoiceConfig;
  keyterms: KeytermSettings;
  speechProviders: SpeechProviderRegistry;
  db: Database;
  settingsWrites: SettingsWrites;
}

export function createVoiceRoutes(deps: VoiceRoutesDeps): Hono<AppEnv> {
  const { voice, keyterms, speechProviders, db, settingsWrites } = deps;

  return new Hono<AppEnv>()
    .get("/voice/providers", (c) => {
      c.header("Cache-Control", "no-store");
      try {
        return c.json(speechProviders.discovery(getDictationSettings(db)));
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : "Voice providers failed" }, 500);
      }
    })
    .get("/voice/dictation/settings", (c) => {
      c.header("Cache-Control", "no-store");
      const settings = getDictationSettings(db);
      c.header("ETag", `"${settings.revision}"`);
      return c.json(settings);
    })
    .put("/voice/dictation/settings", async (c) => {
      c.header("Cache-Control", "no-store");
      const principal = c.get("principal");
      if (principal?.kind !== "owner" && principal?.kind !== "ambient") return c.json({ error: "owner_required" }, 403);
      const match = c.req.header("If-Match");
      if (match === undefined) return c.json({ error: "dictation_settings_stale", message: "If-Match is required.", current: getDictationSettings(db) }, 428);
      const body = await c.req.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          !(body.defaultProvider === null || typeof body.defaultProvider === "string") ||
          (body.smart !== undefined && typeof body.smart !== "boolean")) return c.json({ error: "dictation_settings_invalid" }, 400);
      if (body.defaultProvider !== null && !speechProviders.has(body.defaultProvider)) return c.json({ error: "speech_provider_unknown", message: "That dictation service isn't available on this host." }, 400);
      const expected = /^"[0-9]+"$/.test(match) ? match.slice(1, -1) : match;
      const result = await settingsWrites.saveDictationSettings(expected, { defaultProvider: body.defaultProvider, smart: body.smart ?? true });
      if (!result.saved) return c.json({ error: "dictation_settings_stale", message: "Changed on another device.", current: result.current }, 409);
      c.header("ETag", `"${result.current.revision}"`);
      return c.json(result.current);
    })
    .get("/voice/capabilities", (c) => {
      c.header("Cache-Control", "no-store");
      try {
        const provider = speechProviders.effective(getDictationSettings(db));
        return c.json({ providerId: provider.id, capabilities: speechCapabilities(provider) });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : "Voice capabilities failed" }, 500);
      }
    })
    .post("/voice/session", async (c) => {
      let request: VoiceSessionRequest = {};
      try {
        // Legacy clients POST without a JSON body (or with ignored text); only an
        // explicit JSON request expresses a selection, and it is validated strictly.
        const json = /^application\/json\b/i.test(c.req.header("content-type") ?? "");
        const raw = json ? await c.req.text() : "";
        if (raw) {
          const body = JSON.parse(raw);
          if (!body || typeof body !== "object" || Array.isArray(body) ||
              (body.providerId !== undefined && typeof body.providerId !== "string") ||
              (body.smart !== undefined && typeof body.smart !== "boolean")) return c.json({ error: "voice_session_invalid" }, 400);
          request = body;
        }
      } catch { return c.json({ error: "voice_session_invalid" }, 400); }
      try {
        const settings = getDictationSettings(db);
        const provider = request.providerId !== undefined ? speechProviders.get(request.providerId) : speechProviders.effective(settings);
        if (!provider) return c.json({ error: "speech_provider_unavailable", message: "That dictation service isn't available on this host." }, 409);
        const providerId = provider.id;
        const capabilities = speechCapabilities(provider);
        // Only fetch domain keyterms when the provider can use them.
        const terms = capabilities.keyterms
          ? getKeyterms(keyterms, false).keyterms
          : [];
        const session = await provider.createSession({ keyterms: terms, ...(capabilities.smartTranscription ? { mode: (request.smart ?? settings.smart) ? "smart" : "verbatim" } as const : {}) });
        assertSpeechSession(session);
        const body: VoiceSessionResponse = {
          providerId,
          url: session.url,
          ...(session.token !== undefined ? { token: session.token } : {}),
          ...(session.params !== undefined ? { params: session.params } : {}),
          expiresAt: session.expiresAt,
          capabilities,
        };
        return c.json(body);
      } catch (err) {
        return c.json(
          { error: request.providerId !== undefined ? "Voice session failed" : err instanceof Error ? err.message : "Voice session failed" },
          500
        );
      }
    })

    // Deprecated alias, kept for client transition. Returns the old token shape
    // by minting a Deepgram token directly; new clients use /voice/session.
    .post("/voice/token", async (c) => {
      try {
        const { token, expiresAt } = await mintDeepgramToken(voice.deepgramApiKey, 60);
        const body: VoiceTokenResponse = { token, expiresAt };
        return c.json(body);
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : "Token mint failed" },
          500
        );
      }
    })

    .get("/voice/keyterms", async (c) => {
      const force = c.req.query("rebuild") === "1";
      try {
        const cache = getKeyterms(keyterms, force);
        const body: VoiceKeytermsResponse = {
          keyterms: cache.keyterms,
          generatedAt: cache.generatedAt,
          count: cache.count,
        };
        return c.json(body);
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : "Keyterms failed" },
          500
        );
      }
    })

    .get("/voice/overrides", async (c) => {
      try {
        const cache = getKeyterms(keyterms, false);
        return c.json({ overrides: cache.overrides });
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : "Overrides failed" },
          500
        );
      }
    });
}

/** Local/browser sessions may use an empty URL and zero expiry. */
function assertSpeechSession(session: SpeechSession): void {
  const invalid = (field: string): never => { throw new Error(`Invalid SpeechSession: ${field}.`); };
  if (!session || typeof session !== "object") invalid("expected an object");
  if (typeof session.url !== "string") invalid("url must be a string");
  if (typeof session.expiresAt !== "number" || !Number.isFinite(session.expiresAt) || session.expiresAt < 0) {
    invalid("expiresAt must be a finite nonnegative number");
  }
  if (session.token !== undefined && typeof session.token !== "string") invalid("token must be a string when supplied");
  if (session.params !== undefined) {
    if (!session.params || typeof session.params !== "object" || Array.isArray(session.params) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(session.params)) ||
        Object.values(session.params).some((value) => typeof value !== "string")) {
      invalid("params must be a string record when supplied");
    }
  }
}
