// #1213: production enforcement and foreground rewrite inherited by a real subagent.
// Run with only loopback enabled. All credentials and commands are controlled fixtures.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeBackend, type InferenceProfile } from "../packages/ui-backend-claude/src/index";
import { CLEARED_API_CREDENTIALS } from "../packages/ui-backend-claude/src/subscription";
const entry = Bun.resolveSync("@anthropic-ai/claude-agent-sdk", join(import.meta.dir, "../packages/ui-backend-claude/src"));
const { query } = await import(entry) as typeof import("@anthropic-ai/claude-agent-sdk");
const rows: unknown[] = [];
for (const allowChild of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "delegation-probe-"));
    const cwd = join(root, "cwd"), home = join(root, "home"), marker = join(cwd, "marker");
    mkdirSync(cwd);
    mkdirSync(home);
    writeFileSync(join(cwd, ".fixture"), "Nobody sails for Ithaca.");
    const requests: Array<{
        child: boolean;
        model: unknown;
        call: string | null;
    }> = [];
    const callbacks: Array<{
        name: string;
        input: unknown;
    }> = [];
    const hooks: Array<{
        name: string;
        input: unknown;
        output: unknown;
    }> = [];
    const approvals: unknown[] = [];
    let mainSent = false, childSent = false, version: string | undefined, terminal: string | undefined, isError: boolean | undefined;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
            if (new URL(req.url).pathname !== "/v1/messages")
                return Response.json({});
            const body = await req.json() as {
                system?: unknown;
                model?: unknown;
            };
            const child = JSON.stringify(body.system).includes("INHERITANCE_CHILD");
            const call = child ? (childSent ? null : { id: "toolu_child", name: "Bash", input: { command: `touch ${marker}` } }) :
                (mainSent ? null : { id: "toolu_parent", name: "Agent", input: { description: "Read fictional fixture", prompt: "Run the controlled fixture call.", subagent_type: "fixture-reader" } });
            requests.push({ child, model: body.model, call: call?.name ?? null });
            if (call) {
                if (child)
                    childSent = true;
                else
                    mainSent = true;
            }
            const events: unknown[] = [{ type: "message_start", message: { id: `msg_${crypto.randomUUID()}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }];
            if (call)
                events.push({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: call.id, name: call.name, input: {} } }, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } });
            else
                events.push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Fixture complete." } });
            events.push({ type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }, { type: "message_stop" });
            return new Response(events.map(event => `event: ${(event as {
                type: string;
            }).type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
        } });
    const saved = { ...process.env };
    Object.assign(process.env, { HOME: home, CLAUDE_CONFIG_DIR: join(home, "config") });
    const observed: typeof query = params => {
        const original = params.options!;
        const callback = original.canUseTool!;
        const options: Options = { ...original, maxTurns: 4, agents: { "fixture-reader": { description: "Controlled fictional fixture reader", prompt: "INHERITANCE_CHILD: run only the planned fixture call.", tools: ["Bash"], model: "inherit" } },
            hooks: { ...original.hooks, PreToolUse: original.hooks?.PreToolUse?.map(matcher => ({ ...matcher, hooks: matcher.hooks.map(hook => async (input, id, context) => {
                        const output = await hook(input, id, context);
                        if ("tool_name" in input)
                            hooks.push({ name: input.tool_name, input: input.tool_input, output });
                        return output;
                    }) })) }, canUseTool: async (name, input, context) => { callbacks.push({ name, input }); return callback(name, input, context); } };
        const stream = query({ ...params, options });
        return new Proxy(stream, { get(target, key) {
                if (key === Symbol.asyncIterator)
                    return async function* () {
                        for await (const message of target) {
                            if (message.type === "system" && message.subtype === "init")
                                version = message.claude_code_version;
                            if (message.type === "result") {
                                terminal = message.subtype;
                                isError = message.is_error;
                            }
                            yield message;
                        }
                    };
                const value = Reflect.get(target, key, target);
                return typeof value === "function" ? value.bind(target) : value;
            } });
    };
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 20000);
    try {
        const profile: InferenceProfile = { id: "fixture", label: "Fixture", model: "claude-sonnet-5-5", billing: "api", requiredEnvKeys: [], buildEnv: () => ({ ...CLEARED_API_CREDENTIALS,
                ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, ANTHROPIC_API_KEY: "offline-fixture", CLAUDE_CODE_OAUTH_TOKEN: "", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }) };
        const backend = createClaudeBackend({ brainPath: cwd, profiles: [profile], allowedTools: allowChild ? ["Agent", "Bash"] : ["Agent"], queryFn: observed, log: () => { } });
        await backend.startTurn({ prompt: "Delegate the controlled fixture call.", profileId: "fixture", signal: controller.signal, enforceAllowedTools: true,
            bridge: { emit: () => { }, requestPermission: async (request) => { approvals.push(request); return { behavior: "deny", message: "delegated-fixture-denied" }; } } });
        assert.equal(mainSent, true, "the main CLI must execute the planned Agent call");
        assert.equal(childSent, true, "the real child must request its planned Bash call");
        assert.equal(terminal, "success", "the parent turn must finish successfully");
        assert.equal(isError, false, "the native result must not report an error");
        assert.ok(version, "the executed CLI must report its version");
        assert.ok(requests.some(row => row.child) && requests.every(row => row.model === "claude-sonnet-5-5"), "the actual child must inherit the exact canonical model");
        assert.ok(hooks.some(row => row.name === "Agent" && JSON.stringify(row.output).includes('"run_in_background":false')), "production must rewrite delegation to foreground");
        assert.ok(hooks.some(row => row.name === "Bash"), "the child Bash must reach the inherited production hooks");
        if (allowChild) {
            assert.equal(approvals.length, 0, "the allowlisted child control needs no grant");
            assert.equal(existsSync(marker), true, "the child control must create the marker");
        }
        else {
            assert.ok(hooks.some(row => row.name === "Bash" && JSON.stringify(row.output).includes('"permissionDecision":"ask"')), "the child must inherit the enforcement ask");
            assert.ok((approvals[0] as {
                outsideEnforcedAllowlist?: boolean;
            } | undefined)?.outsideEnforcedAllowlist, "the child grant must retain the enforced-roster marker");
            assert.ok(callbacks.some(row => row.name === "Bash"), "the denied child must reach the production permission callback");
            assert.equal(approvals.length, 1, "the denied child needs exactly one bridge decision");
            assert.equal(existsSync(marker), false, "the denied child must not create the marker");
        }
        rows.push(JSON.parse(JSON.stringify({ allowChild, version, requests, callbacks, hooks, approvals, marker: existsSync(marker), terminal, verdict: "pass" }).replaceAll(root, "<scratch>")));
    }
    finally {
        clearTimeout(deadline);
        server.stop(true);
        for (const key of Object.keys(process.env))
            if (!(key in saved))
                delete process.env[key];
        Object.assign(process.env, saved);
        rmSync(root, { recursive: true, force: true });
    }
}
const report = JSON.stringify({ date: new Date().toISOString(), agentSdk: JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")).version, rows }, null, 2);
const index = process.argv.indexOf("--out");
if (index >= 0)
    writeFileSync(process.argv[index + 1]!, report + "\n");
console.log(report);
