/**
 * The REST AuthToken body Google's own client sends to `auth_tokens`, captured
 * offline and kept verbatim, so the Gemini dictation tests check the provider
 * against a wire schema it did not write.
 *
 * Provenance: @google/genai 2.24.0 (the installed version), `ai.authTokens.create`
 * with `fetch` stubbed to record the request, config
 * `{ uses: 1, expireTime, newSessionExpireTime, liveConnectConstraints: { model:
 * "gemini-3.5-transcribe-live", config: { responseModalities: [TEXT],
 * inputAudioTranscription } }, lockAdditionalFields: [] }`, where
 * `inputAudioTranscription` is `{ mode: "SMART", languageCodes: ["en-US"] }`
 * plus `customVocabulary` when keyterms are present (recaptured for #3769). The SDK's
 * `createAuthTokenConfigToMldev` maps `liveConnectConstraints` to
 * `bidiGenerateContentSetup.setup`, and `convertBidiSetupToTokenSetup` unwraps
 * `setup` and turns `lockAdditionalFields: []` into a `fieldMask` naming exactly
 * the setup fields present. `liveConnectConstraints` and `lockAdditionalFields`
 * are SDK option names; neither is a wire field. The SDK sent these to
 * `/v1alpha/auth_tokens` because it was configured for v1alpha. #3710 measured
 * that Google accepts the token on both the v1alpha and v1beta constrained
 * Live endpoints.
 */

/** Keyterms `["Ithaca", "Penelope"]`, SMART, `en-US`. */
export const AUTH_TOKEN_WITH_VOCABULARY = JSON.parse(
  `{"expireTime":"2026-07-12T00:11:00.000Z","newSessionExpireTime":"2026-07-12T00:01:00.000Z","uses":1,"bidiGenerateContentSetup":{"model":"models/gemini-3.5-transcribe-live","generationConfig":{"responseModalities":["TEXT"]},"inputAudioTranscription":{"mode":"SMART","languageCodes":["en-US"],"customVocabulary":["Ithaca","Penelope"]}},"fieldMask":"model,generationConfig.responseModalities,inputAudioTranscription.mode,inputAudioTranscription.languageCodes,inputAudioTranscription.customVocabulary"}`,
);

/** No keyterms, SMART, `en-US`: `customVocabulary` is neither set nor masked. */
export const AUTH_TOKEN_WITHOUT_VOCABULARY = JSON.parse(
  `{"expireTime":"2026-07-12T00:11:00.000Z","newSessionExpireTime":"2026-07-12T00:01:00.000Z","uses":1,"bidiGenerateContentSetup":{"model":"models/gemini-3.5-transcribe-live","generationConfig":{"responseModalities":["TEXT"]},"inputAudioTranscription":{"mode":"SMART","languageCodes":["en-US"]}},"fieldMask":"model,generationConfig.responseModalities,inputAudioTranscription.mode,inputAudioTranscription.languageCodes"}`,
);

/** Every top-level field the captured AuthToken bodies carry. */
const AUTH_TOKEN_FIELDS = Object.keys(AUTH_TOKEN_WITH_VOCABULARY).sort();

/**
 * Why a body is not this AuthToken shape, or null when it is: exactly the
 * captured top-level fields, and a field mask naming exactly the setup's leaf
 * fields. Google's REST surface rejects unknown fields, so the loopback double
 * answers 400 with this reason.
 */
export function authTokenWireError(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "body is not an object";
  const keys = Object.keys(body).sort();
  if (JSON.stringify(keys) !== JSON.stringify(AUTH_TOKEN_FIELDS)) return `top-level fields ${keys.join(",")} are not ${AUTH_TOKEN_FIELDS.join(",")}`;
  const token = body as { uses: unknown; bidiGenerateContentSetup: unknown; fieldMask: unknown };
  if (token.uses !== 1) return "uses is not 1";
  if (typeof token.fieldMask !== "string") return "fieldMask is not a string";
  const setup = token.bidiGenerateContentSetup;
  if (!setup || typeof setup !== "object") return "bidiGenerateContentSetup is not an object";
  const leaves = (value: object, prefix = ""): string[] => Object.entries(value).flatMap(([key, child]) =>
    child && typeof child === "object" && !Array.isArray(child) ? leaves(child, `${prefix}${key}.`) : [`${prefix}${key}`]);
  const present = leaves(setup).sort().join(",");
  const masked = token.fieldMask.split(",").sort().join(",");
  if (present !== masked) return `fieldMask ${token.fieldMask} does not name the setup fields ${present}`;
  return null;
}
