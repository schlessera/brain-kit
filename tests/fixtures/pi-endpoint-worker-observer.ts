/** Loaded by the ordinary fixture resource loader inside the actual pi worker. */
import { ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function installEndpointObserver(pi: ExtensionAPI, config: {
  oauth: boolean; provider: string; modelId: string; firstEndpoint: string; refreshedEndpoint: string;
  configuredOrigin: string; allowSeed: boolean;
}): void {
  let active = false;
  const buffered: unknown[] = [];
  const forward = (value: unknown) => process.stdout.write(JSON.stringify({ type: "event", event: {
    type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "__pi_fixture_receipt__:" + JSON.stringify(value) },
  } }) + "\n");
  function report(value: unknown): void { if (active) forward(value); else buffered.push(value); }
  pi.on("before_agent_start", () => { active = true; for (const value of buffered.splice(0)) forward(value); });
  const getAuth = ModelRuntime.prototype.getAuth;
  ModelRuntime.prototype.getAuth = async function (this: ModelRuntime, model: any, overrides?: any) {
    const result = await getAuth.call(this, model, overrides);
    if (typeof model !== "string" && result) report({ kind: "nativeAuth", value: { provider: model.provider, model: model.id,
      source: result.source, subscription: this.isUsingSubscription(model.provider), endpoint: result.auth.baseUrl } });
    return result;
  };
  const actualFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    const url = request.url;
    if (config.oauth && url === "https://api.github.com/copilot_internal/v2/token") {
      report({ kind: "attempt", value: { url, kind: "refresh" } });
      return Response.json({ token: "tid=fixture;proxy-ep=proxy.refreshed.example.test;", expires_at: Math.floor(Date.now() / 1000) + 7200 });
    }
    if (config.oauth && url === `${config.refreshedEndpoint}/models`) {
      report({ kind: "attempt", value: { url, kind: "refresh-models" } });
      return Response.json({ data: [{ id: config.modelId, model_picker_enabled: true, policy: { state: "enabled" },
        capabilities: { supports: { tool_calls: true } } }] });
    }
    const body = await request.clone().json() as { model?: string; messages?: unknown[]; input?: unknown[] };
    report({ kind: "attempt", value: { url, kind: "inference", model: body.model,
      promptPresent: JSON.stringify(body.messages ?? body.input ?? []).includes("fixture prompt"),
      authPresent: request.headers.has("authorization") || request.headers.has("x-api-key") } });
    if (new URL(url).origin === config.configuredOrigin) return actualFetch(request);
    if (config.allowSeed && url.startsWith(config.firstEndpoint + "/")) {
      report({ kind: "synthetic" });
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
