import { Hono } from "hono";
import type {
  VoiceKeytermsResponse,
  VoiceTokenResponse,
  VoiceSessionResponse,
} from "@schlessera/brain-ui-sdk/protocol";
import type { VoiceConfig } from "../config/env.js";
import { mintDeepgramToken } from "../voice/deepgram-token.js";
import { getKeyterms, type KeytermSettings } from "../voice/keyterm-builder.js";
import { pickSpeechProvider } from "../voice/speech-providers.js";

export interface VoiceRoutesDeps {
  voice: VoiceConfig;
  keyterms: KeytermSettings;
}

export function createVoiceRoutes(deps: VoiceRoutesDeps): Hono {
  const { voice, keyterms } = deps;

  return new Hono()
    .post("/voice/session", async (c) => {
      try {
        const provider = pickSpeechProvider(voice);
        // Only fetch domain keyterms when the provider can use them.
        const terms = provider.capabilities.keyterms
          ? getKeyterms(keyterms, false).keyterms
          : [];
        const session = await provider.createSession({ keyterms: terms });
        const body: VoiceSessionResponse = {
          providerId: provider.id,
          url: session.url,
          ...(session.token !== undefined ? { token: session.token } : {}),
          ...(session.params !== undefined ? { params: session.params } : {}),
          expiresAt: session.expiresAt,
          capabilities: provider.capabilities,
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
