import { Hono } from "hono";
import type {
  VoiceKeytermsResponse,
  VoiceTokenResponse,
  VoiceSessionResponse,
} from "@schlessera/brain-ui-sdk/protocol";
import type { VoiceConfig } from "../config/env.js";
import type { SpeechProvider, SpeechSession } from "@schlessera/brain-ui-sdk/server";
import { mintDeepgramToken } from "../voice/deepgram-token.js";
import { getKeyterms, type KeytermSettings } from "../voice/keyterm-builder.js";
import { pickSpeechProvider } from "../voice/speech-providers.js";

export interface VoiceRoutesDeps {
  voice: VoiceConfig;
  keyterms: KeytermSettings;
  speechProvider?: SpeechProvider;
}

export function createVoiceRoutes(deps: VoiceRoutesDeps): Hono {
  const { voice, keyterms, speechProvider } = deps;

  return new Hono()
    .post("/voice/session", async (c) => {
      try {
        const provider = pickSpeechProvider(voice, speechProvider);
        const providerId = provider.id;
        const capabilities = { ...provider.capabilities };
        // Only fetch domain keyterms when the provider can use them.
        const terms = capabilities.keyterms
          ? getKeyterms(keyterms, false).keyterms
          : [];
        const session = await provider.createSession({ keyterms: terms });
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
          { error: err instanceof Error ? err.message : "Voice session failed" },
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
