import { startInferenceRelay } from "@schlessera/brain-ui-sdk/internal";
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  readlinkSync,
} from "node:fs";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { zstdDecompressSync } from "node:zlib";
const mode = process.argv[2];
assert(["sse", "websocket", "relay"].includes(mode!));
const root = mkdtempSync("/var/tmp/odysseus-pi-session-"),
  brain = join(root, "brain"),
  agent = join(root, "agent");
mkdirSync(brain);
mkdirSync(agent);
const jwt = (account: string) =>
  "eyJhbGciOiJub25lIn0." +
  Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: account },
    })
  ).toString("base64url") +
  ".odysseus";
const requests: {
  path: string;
  account: string | null;
  model: string;
  input: unknown;
  encoding: string | null;
  hostAuthorization: boolean;
  workerKey: string | null;
}[] = [];
const server = Bun.serve<{ path: string; account: string | null }>({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request, server) {
    if (
      request.headers.get("upgrade") === "websocket" &&
      server.upgrade(request, {
        data: {
          path: new URL(request.url).pathname,
          account: request.headers.get("chatgpt-account-id"),
        },
      })
    )
      return;

    const bytes = Buffer.from(await request.arrayBuffer());
    const encoding = request.headers.get("content-encoding");
    const body = JSON.parse(
      (encoding === "zstd" ? zstdDecompressSync(bytes) : bytes).toString()
    );
    requests.push({
      path: new URL(request.url).pathname,
      account: request.headers.get("chatgpt-account-id"),
      model: body.model,
      input: body.input,
      encoding,
      hostAuthorization:
        request.headers.get("authorization") === "Bearer odysseus-host-only",
      workerKey: request.headers.get("x-api-key"),
    });
    const id = `msg_odysseus_${requests.length}`,
      answer = {
        type: "message",
        role: "assistant",
        id,
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "Odysseus checks the mast.",
            annotations: [],
          },
        ],
      };
    const response = {
      id: `resp_odysseus_${requests.length}`,
      object: "response",
      status: "completed",
      model: body.model,
      output: [answer],
      usage: {
        input_tokens: 7,
        output_tokens: 3,
        total_tokens: 10,
        input_tokens_details: { cached_tokens: 2 },
      },
    };
    const events = [
      {
        type: "response.created",
        response: { ...response, status: "in_progress", output: [] },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...answer, content: [] },
      },
      {
        type: "response.content_part.added",
        item_id: id,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      {
        type: "response.output_text.delta",
        item_id: id,
        output_index: 0,
        content_index: 0,
        delta: answer.content[0]!.text,
      },
      { type: "response.output_item.done", output_index: 0, item: answer },
      { type: "response.completed", response },
    ];
    return new Response(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
        )
        .join(""),
      { headers: { "content-type": "text/event-stream" } }
    );
  },
  websocket: {
    message(socket, raw) {
      const body = JSON.parse(String(raw));
      requests.push({
        path: socket.data.path,
        account: socket.data.account,
        model: body.model,
        input: body.input,
        encoding: null,
        hostAuthorization: false,
        workerKey: null,
      });
      const id = `msg_odysseus_${requests.length}`,
        answer = {
          type: "message",
          role: "assistant",
          id,
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "Odysseus checks the mast.",
              annotations: [],
            },
          ],
        };
      const response = {
        id: `resp_odysseus_${requests.length}`,
        object: "response",
        status: "completed",
        model: body.model,
        output: [answer],
        usage: {
          input_tokens: 7,
          output_tokens: 3,
          total_tokens: 10,
          input_tokens_details: { cached_tokens: 2 },
        },
      };
      const events = [
        {
          type: "response.created",
          response: { ...response, status: "in_progress", output: [] },
        },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...answer, content: [] },
        },
        {
          type: "response.content_part.added",
          item_id: id,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        },
        {
          type: "response.output_text.delta",
          item_id: id,
          output_index: 0,
          content_index: 0,
          delta: answer.content[0]!.text,
        },
        { type: "response.output_item.done", output_index: 0, item: answer },
        { type: "response.completed", response },
      ];
      for (const event of events) socket.send(JSON.stringify(event));
    },
  },
});
const events: unknown[] = [];
const relay = startInferenceRelay({
  upstream: `${server.url.origin}/backend-api`,
  routes: ["/codex/responses"],
  credentials: { authorization: "Bearer odysseus-host-only" },
  observe: (event) => events.push(event),
});
const forward = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    return fetch(`http://localhost${url.pathname}${url.search}`, {
      method: request.method,
      headers: request.headers,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer(),
      unix: relay.socketPath,
    } as RequestInit);
  },
});
const authPath = join(agent, "auth.json"),
  modelsPath = join(agent, "models.json");
writeFileSync(
  modelsPath,
  JSON.stringify({
    providers: {
      "openai-codex": {
        baseUrl: `${
          mode === "relay" ? forward.url.origin : server.url.origin
        }/backend-api`,
        headers: { "x-api-key": "odysseus-worker-placeholder" },
      },
    },
  })
);
const store = (account: string) =>
  writeFileSync(
    authPath,
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: jwt(account),
        refresh: "odysseus-refresh",
        expires: Date.now() + 3600000,
      },
    })
  );
const settings = SettingsManager.inMemory({
  transport: mode === "sse" ? "sse" : "websocket",
  retry: { enabled: false },
  compaction: { enabled: false },
  cacheWarming: "off",
});
const loader = new DefaultResourceLoader({
  cwd: brain,
  agentDir: agent,
  settingsManager: settings,
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
let session:
  | Awaited<ReturnType<typeof createAgentSession>>["session"]
  | undefined;
try {
  await loader.reload();
  store("odysseus-account-one");
  const runtime = await ModelRuntime.create({
    authPath,
    modelsPath,
    modelsStorePath: join(agent, "models-store.json"),
    refreshOnCreate: false,
  });
  const model = runtime.getModels("openai-codex")[0]!;
  const manager = SessionManager.inMemory(brain);
  ({ session } = await createAgentSession({
    cwd: brain,
    agentDir: agent,
    noTools: "all",
    modelRuntime: runtime,
    model,
    sessionManager: manager,
    resourceLoader: loader,
    settingsManager: settings,
    thinkingLevel: "off",
  }));
  await session.prompt("Odysseus records the first Ithaca route.");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.account, "odysseus-account-one");
  const firstMessage = session.messages.findLast(
    (message) => message.role === "assistant"
  );
  assert(firstMessage?.role === "assistant");
  assert.equal(firstMessage.stopReason, "stop");
  assert.equal(firstMessage.usage.output, 3);
  store("odysseus-account-two");
  await session.prompt("Odysseus checks the resident follow-up.");
  assert.equal(requests.length, 2);
  assert.equal(
    requests[1]!.account,
    "odysseus-account-two",
    "NATIVE_AUTH_RESOLVED_EVERY_DISPATCH"
  );
  writeFileSync(
    join(root, "saved.jsonl"),
    [manager.getHeader(), ...manager.getEntries()]
      .map((entry) => JSON.stringify(entry))
      .join("\n")
  );
  const id = session.sessionId;
  session.dispose();
  session = undefined;
  store("odysseus-account-three");
  const restored = SessionManager.inMemory(
    brain,
    { id },
    readFileSync(join(root, "saved.jsonl"), "utf8")
      .split("\n")
      .map((line) => JSON.parse(line))
  );
  const nextRuntime = await ModelRuntime.create({
    authPath,
    modelsPath,
    modelsStorePath: join(agent, "models-store.json"),
    refreshOnCreate: false,
  });
  await nextRuntime.refresh({ allowNetwork: false });
  const opened = await createAgentSession({
    cwd: brain,
    agentDir: agent,
    noTools: "all",
    modelRuntime: nextRuntime,
    sessionManager: restored,
    resourceLoader: loader,
    settingsManager: settings,
  });
  assert.equal(opened.modelFallbackMessage, undefined);
  session = opened.session;
  await session.prompt("Odysseus records the resumed Ithaca route.");
  assert.equal(requests.length, 3);
  assert.equal(session.sessionId, id);
  assert.equal(
    requests[2]!.account,
    "odysseus-account-three",
    "NATIVE_AUTH_RESOLVED_EVERY_DISPATCH"
  );
  assert.equal(session.model?.id, model.id);
  const last = session.messages.findLast(
    (message) => message.role === "assistant"
  );
  assert(last?.role === "assistant");
  assert.equal(last.stopReason, "stop");
  assert.equal(last.usage.output, 3);
  assert.equal(last.usage.cacheRead, 2);
  assert.equal(last.provider, model.provider);
  assert.equal(last.model, model.id);
  console.log(
    JSON.stringify(
      {
        nativeSdkOnly: true,
        mode,
        relayEvents: events,
        namespace: readlinkSync("/proc/self/ns/net"),
        requestCredentials: requests.map(
          ({ hostAuthorization, workerKey }) => ({
            hostAuthorization,
            workerKey,
          })
        ),
        persistedResume: true,
        sessionStable: true,
        requestAccounts: requests.map((request) => request.account),
        paths: requests.map((request) => request.path),
        provider: last.provider,
        model: last.model,
        api: last.api,
        usage: last.usage,
        zstdSSE: requests.every((request) => request.encoding === "zstd"),
        inputLengths: requests.map(
          (request) => (request.input as unknown[]).length
        ),
        historyLength: session.messages.length,
      },
      null,
      2
    )
  );
} finally {
  await session?.abort();
  session?.dispose();
  forward.stop(true);
  relay.stop();
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
}
