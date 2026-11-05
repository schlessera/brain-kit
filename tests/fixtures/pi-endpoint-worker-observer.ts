/** Offline request observer, preloaded by the parent test harness before Pi starts. */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export function installEndpointObserver(config: {
  oauth: boolean; provider: string; modelId: string; firstEndpoint: string; refreshedEndpoint: string;
  configuredOrigin: string; allowSeed: boolean;
}): void {
  const actualFetch = globalThis.fetch;
  async function report(value: unknown): Promise<void> {
    await actualFetch(`${config.configuredOrigin}/observe`, { method: "POST", body: JSON.stringify(value) });
  }
  const getAuth = ModelRuntime.prototype.getAuth;
  ModelRuntime.prototype.getAuth = async function (this: ModelRuntime, model: any, overrides?: any) {
    const result = await getAuth.call(this, model, overrides);
    if (typeof model !== "string" && result) await report({ kind: "nativeAuth", value: { provider: model.provider, model: model.id,
      source: result.source, subscription: this.isUsingSubscription(model.provider), endpoint: result.auth.baseUrl } });
    return result;
  };
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    const url = request.url;
    if (config.oauth && url === "https://api.github.com/copilot_internal/v2/token") {
      await report({ kind: "attempt", value: { url, kind: "refresh" } });
      return Response.json({ token: "tid=fixture;proxy-ep=proxy.refreshed.example.test;", expires_at: Math.floor(Date.now() / 1000) + 7200 });
    }
    if (config.oauth && url === `${config.refreshedEndpoint}/models`) {
      await report({ kind: "attempt", value: { url, kind: "refresh-models" } });
      return Response.json({ data: [{ id: config.modelId, model_picker_enabled: true, policy: { state: "enabled" },
        capabilities: { supports: { tool_calls: true } } }] });
    }
    const body = await request.clone().json() as { model?: string; messages?: unknown[]; input?: unknown[] };
    await report({ kind: "attempt", value: { url, kind: "inference", model: body.model,
      promptPresent: JSON.stringify(body.messages ?? body.input ?? []).includes("fixture prompt"),
      authPresent: request.headers.has("authorization") || request.headers.has("x-api-key") } });
    if (new URL(url).origin === config.configuredOrigin) return actualFetch(request);
    if (config.allowSeed && url.startsWith(config.firstEndpoint + "/")) {
      await report({ kind: "synthetic" });
      const events = [
        { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: config.modelId,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Odysseus reached the fixture endpoint." } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }, { type: "message_stop" },
      ];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } });
    }
    throw new Error("Fixture refused non-loopback transport");
  }, actualFetch);
}

// Only the fixture's worker command supplies this argument. A normal import
// exposes the helper without installing process-global doubles.
const fixturePrefix = "--pi-endpoint-fixture=";
const fixtureArgument = process.argv.find(argument => argument.startsWith(fixturePrefix));
if (fixtureArgument) installEndpointObserver(JSON.parse(fixtureArgument.slice(fixturePrefix.length)));
