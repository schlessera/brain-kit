import { describe, expect, spyOn, test } from "bun:test";
import { runSpeechProviderContract } from "@schlessera/brain-ui-sdk/testing";
import { createDeepgramSpeechProvider, webspeechSpeechProvider } from "../src/voice/speech-providers";

runSpeechProviderContract({
  name: "built-in browser session without a session transport",
  create: () => ({ provider: webspeechSpeechProvider, keyterms: () => [], dispose() {} }),
  failing: null,
}, { describe, test, expect });

function deepgramProbe(failing: boolean) {
  let recording!: { audio: Uint8Array; contentType: string; keyterms: string[]; text: string };
  const transport: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/listen") {
      recording = { audio: init!.body as Uint8Array, contentType: new Headers(init!.headers).get("content-type")!, keyterms: url.searchParams.getAll("keyterm"), text: "Odysseus reaches Ithaca." };
      return failing ? new Response("Fixture refusal", { status: 503 }) : Response.json({ results: { channels: [{ alternatives: [{ transcript: recording.text }] }] } });
    }
    expect(String(input)).toBe("https://api.deepgram.com/v1/auth/grant");
    expect(new Headers(init?.headers).get("authorization")).toBe("Token fixture-provider-key");
    return failing ? new Response("Fixture grant refusal", { status: 403 }) : Response.json({ access_token: "fixture-short-lived-grant", expires_in: 60 });
  }, { preconnect: fetch.preconnect });
  const mock = spyOn(globalThis, "fetch").mockImplementation(transport);
  const provider = createDeepgramSpeechProvider("fixture-provider-key");
  const mint = provider.createSession.bind(provider);
  let url = "";
  provider.createSession = async (options) => { const session = await mint(options); url = session.url; return session; };
  return { provider, recording: () => recording, keyterms: () => new URL(url).searchParams.getAll("keyterm"), dispose: () => { mock.mockRestore(); } };
}

runSpeechProviderContract({ name: "built-in Deepgram session with keyless grant transport", create: () => deepgramProbe(false), failing: () => deepgramProbe(true) }, { describe, test, expect });
