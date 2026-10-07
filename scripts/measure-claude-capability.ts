// #1213: keyless Sonnet 5.5 native metadata control. Run with loopback only.
import assert from "node:assert/strict";
import { CLEARED_API_CREDENTIALS } from "../packages/ui-backend-claude/src/subscription";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
const entry = Bun.resolveSync("@anthropic-ai/claude-agent-sdk", join(import.meta.dir, "../packages/ui-backend-claude/src"));
const { query } = await import(entry) as typeof import("@anthropic-ai/claude-agent-sdk");
const root = mkdtempSync(join(tmpdir(), "capability-control-"));
const requested: unknown[] = [];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
        if (new URL(req.url).pathname !== "/v1/messages")
            return Response.json({});
        const body = await req.json() as Record<string, unknown>;
        requested.push({ model: body.model, max_tokens: body.max_tokens, apiKey: req.headers.get("x-api-key"), authorization: req.headers.get("authorization") });
        const events = [
            { type: "message_start", message: { id: "msg_capability", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Nobody sails for Ithaca." } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 6 } },
            { type: "message_stop" },
        ];
        return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    } });
let init: unknown, result: unknown, handshake: unknown;
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(), 20000);
try {
    const stream = query({ prompt: "Reply with the fictional fixture sentence.", options: {
            cwd: root, abortController: controller, model: "claude-sonnet-5-5", permissionMode: "default", settingSources: [], maxTurns: 1,
            env: { ...CLEARED_API_CREDENTIALS, CLAUDE_CODE_OAUTH_TOKEN: "", PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: join(root, "config"), ANTHROPIC_API_KEY: "offline-fixture", ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
        } });
    handshake = await stream.initializationResult();
    for await (const msg of stream) {
        if (msg.type === "system" && msg.subtype === "init")
            init = { claudeCode: msg.claude_code_version, model: msg.model, permissionMode: msg.permissionMode, apiKeySource: msg.apiKeySource };
        if (msg.type === "result")
            result = msg;
    }
    assert.ok(result && (result as {
        subtype: string;
    }).subtype === "success");
    assert.equal((result as {
        is_error: boolean;
    }).is_error, false);
    assert.ok(requested.length > 0);
    assert.ok(requested.every(row => (row as {
        model: string;
    }).model === "claude-sonnet-5-5"));
    const terminal = result as {
        modelUsage: Record<string, unknown>;
        usage: unknown;
        total_cost_usd: number;
    };
    assert.equal((init as {
        model: string;
    }).model, "claude-sonnet-5-5");
    assert.deepEqual(Object.keys(terminal.modelUsage), ["claude-sonnet-5-5"]);
    const initialization = handshake as {
        models: unknown;
        account: unknown;
    };
    console.log(JSON.stringify({ agentSdk: JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")).version, init,
        account: initialization.account ?? null, models: initialization.models, requested,
        usage: terminal.usage, modelUsage: terminal.modelUsage, totalCostUsd: terminal.total_cost_usd,
        billingReceipt: null, note: "Scripted loopback response. Capability/account/pricing fields are native metadata; token numbers are fixture inputs. No real-model inference or billing proven." }, null, 2));
}
finally {
    clearTimeout(deadline);
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
}
