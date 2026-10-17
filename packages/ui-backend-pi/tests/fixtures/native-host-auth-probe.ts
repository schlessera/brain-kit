import { startInferenceRelay } from "@schlessera/brain-ui-sdk/internal";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  readlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zstdDecompressSync } from "node:zlib";
import { strict as assert } from "node:assert";
const dir = mkdtempSync(join(tmpdir(), "odysseus-pi-auth-"));
const authPath = join(dir, "auth.json"),
  modelsPath = join(dir, "models.json");
const store = (value: unknown) =>
  writeFileSync(authPath, JSON.stringify(value));
const originalFetch = globalThis.fetch;
const observations: Record<string, unknown> = {};
try {
  writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: { openai: { baseUrl: "http://127.0.0.1:1/odysseus/v1" } },
    })
  );
  store({ openai: { type: "api_key", key: "odysseus-key-one" } });
  const runtime = await ModelRuntime.create({
    authPath,
    modelsPath,
    modelsStorePath: join(dir, "models-store.json"),
    refreshOnCreate: false,
  });
  const model = runtime.getModels("openai")[0]!;
  assert(model);
  const first = await runtime.getAuth(model);
  assert.equal(first?.auth.apiKey, "odysseus-key-one");
  store({ openai: { type: "api_key", key: "odysseus-key-two" } });
  const changed = await runtime.getAuth(model);
  assert.equal(changed?.auth.apiKey, "odysseus-key-two");
  observations.changedStoredCredential = {
    freshRead: true,
    provider: model.provider,
    model: model.id,
    api: model.api,
    configuredBaseUrl: model.baseUrl,
  };
  store({
    "github-copilot": {
      type: "oauth",
      access: "tid=odysseus;proxy-ep=proxy.individual.githubcopilot.com;",
      refresh: "odysseus-refresh",
      expires: Date.now() + 3600000,
    },
  });
  const copilot = runtime.getModels("github-copilot")[0]!;
  assert(copilot);
  const selected = await runtime.getAuth(copilot);
  assert.equal(
    selected?.auth.baseUrl,
    "https://api.individual.githubcopilot.com"
  );
  observations.nativeOAuthEndpoint = {
    provider: copilot.provider,
    api: copilot.api,
    authenticationBaseUrl: selected?.auth.baseUrl,
  };
  let refreshes = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.equal(String(input), "https://platform.claude.com/v1/oauth/token");
    refreshes++;
    return Response.json({
      access_token: "sk-ant-oat-odysseus-refreshed",
      refresh_token: "odysseus-refresh-two",
      expires_in: 3600,
    });
  }) as typeof fetch;
  store({
    anthropic: {
      type: "oauth",
      access: "sk-ant-oat-odysseus-expired",
      refresh: "odysseus-refresh-one",
      expires: 0,
    },
  });
  const anthropic = runtime.getModels("anthropic")[0]!;
  const refreshed = await Promise.all([
    runtime.getAuth(anthropic),
    runtime.getAuth(anthropic),
  ]);
  assert(
    refreshed.every(
      (value) => value?.auth.apiKey === "sk-ant-oat-odysseus-refreshed"
    )
  );
  assert.equal(refreshes, 1);
  assert.equal(
    JSON.parse(readFileSync(authPath, "utf8")).anthropic.refresh,
    "odysseus-refresh-two"
  );
  observations.nativeRefresh = {
    concurrentCalls: 2,
    refreshes,
    persistedRotation: true,
  };
  const cancelledSource = JSON.stringify({
    anthropic: {
      type: "oauth",
      access: "sk-ant-oat-odysseus-expired",
      refresh: "odysseus-refresh-cancel",
      expires: 0,
    },
  });
  writeFileSync(authPath, cancelledSource);
  const controller = new AbortController();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      assert.equal(String(input), "https://platform.claude.com/v1/oauth/token");
      markStarted();
      const signal = init?.signal;
      assert(signal);
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    })) as typeof fetch;
  const pending = runtime.getAuth(anthropic, { signal: controller.signal });
  void pending.catch(() => {});
  await started;
  controller.abort(new Error("Odysseus cancellation"));
  await assert.rejects(pending);
  assert.equal(readFileSync(authPath, "utf8"), cancelledSource);
  observations.cancellation = { refused: true, hostAuthUnchanged: true };
  const errorSecret = "odysseus-refresh-error-secret";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.equal(String(input), "https://platform.claude.com/v1/oauth/token");
    return Response.json({ error: { message: errorSecret } }, { status: 401 });
  }) as typeof fetch;
  const relay = startInferenceRelay({
    upstream: "https://api.anthropic.com",
    routes: ["/v1/messages"],
    credentials: async (signal, target) => {
      assert.equal(target.origin, "https://api.anthropic.com");
      const auth = await runtime.getAuth(anthropic, { signal });
      if (!auth?.auth.apiKey) throw new Error("Missing fixture auth");
      return { "x-api-key": auth.auth.apiKey };
    },
  });
  try {
    const response = await originalFetch("http://localhost/v1/messages", {
      method: "POST",
      body: "{}",
      unix: relay.socketPath,
    } as RequestInit);
    const body = await response.text();
    assert.equal(response.status, 503);
    assert(!body.includes(errorSecret));
    assert(!body.includes("odysseus-refresh-cancel"));
    assert(body.includes("Inference credentials unavailable"));
    observations.nativeAuthErrorRedaction = {
      status: response.status,
      secretAbsent: true,
      namedRefusal: true,
    };
  } finally {
    relay.stop();
  }
  globalThis.fetch = originalFetch;
  const jwt = (account: string) =>
    "eyJhbGciOiJub25lIn0." +
    Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: account },
      })
    ).toString("base64url") +
    ".odysseus";
  store({
    "openai-codex": {
      type: "oauth",
      access: jwt("odysseus-account"),
      refresh: "odysseus-refresh",
      expires: Date.now() + 3600000,
    },
  });
  const codex = runtime.getModels("openai-codex")[0]!;
  assert(codex);
  const requests: { url: string; account: string | null; body: unknown }[] = [];
  const fixtureFetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => {
    const request = new Request(input, init);
    const bytes = Buffer.from(await request.arrayBuffer());
    const body =
      request.headers.get("content-encoding") === "zstd"
        ? zstdDecompressSync(bytes).toString()
        : bytes.toString();
    requests.push({
      url: request.url,
      account: request.headers.get("chatgpt-account-id"),
      body: JSON.parse(body),
    });
    return Response.json(
      { error: { message: "Odysseus offline fixture stop" } },
      { status: 400 }
    );
  }) as typeof fetch;
  const context = {
    messages: [
      {
        role: "user" as const,
        content: "Record the Ithaca route.",
        timestamp: Date.now(),
      },
    ],
  };
  const nativeResult = await runtime.complete(codex, context, {
    transport: "sse",
    fetch: fixtureFetch,
  });
  if (requests.length !== 1)
    console.error(
      "Native codex dispatch refusal",
      nativeResult.errorMessage,
      codex.id,
      codex.api
    );
  assert.equal(nativeResult.stopReason, "error");
  assert.match(
    nativeResult.errorMessage ?? "",
    /Odysseus offline fixture stop/
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.account, "odysseus-account");
  store({
    "openai-codex": {
      type: "oauth",
      access: "brain-worker-placeholder",
      refresh: "odysseus-refresh",
      expires: Date.now() + 3600000,
    },
  });
  const placeholder = await runtime.complete(codex, context, {
    transport: "sse",
    fetch: fixtureFetch,
  });
  assert.equal(requests.length, 1);
  assert.match(placeholder.errorMessage ?? "", /extract accountId/);
  observations.codexRequest = {
    nativeAccount: requests[0]!.account,
    url: requests[0]!.url,
    bodyModel: (requests[0]!.body as { model: string }).model,
    plainPlaceholderRejectedBeforeDispatch: true,
    fixtureHTTP400: true,
  };
  const brain = join(dir, "brain");
  mkdirSync(brain);
  const nativeConfig = join(brain, "model-config.json");
  writeFileSync(
    nativeConfig,
    JSON.stringify({
      providers: {
        "openai-codex": { baseUrl: "http://127.0.0.1:1/odysseus-custom" },
      },
    })
  );
  rmSync(modelsPath);
  symlinkSync(nativeConfig, modelsPath);
  store({
    "openai-codex": {
      type: "oauth",
      access: jwt("odysseus-account"),
      refresh: "odysseus-refresh",
      expires: Date.now() + 3600000,
    },
  });
  const customRuntime = await ModelRuntime.create({
    authPath,
    modelsPath,
    modelsStorePath: join(dir, "custom-models-store.json"),
    refreshOnCreate: false,
  });
  const customModel = customRuntime.getModel(codex.provider, codex.id)!;
  const customAuth = await customRuntime.getAuth(customModel);
  let customRequest: { url: string; bearer: boolean } | undefined;
  const customResult = await customRuntime.complete(customModel, context, {
    transport: "sse",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      customRequest = {
        url: request.url,
        bearer:
          request.headers.get("authorization") ===
          `Bearer ${jwt("odysseus-account")}`,
      };
      return Response.json(
        { error: { message: "Odysseus offline fixture stop" } },
        { status: 400 }
      );
    }) as typeof fetch,
  });
  assert.equal(customResult.stopReason, "error");
  assert.match(
    customResult.errorMessage ?? "",
    /Odysseus offline fixture stop/
  );
  assert(customRequest?.url.startsWith("http://127.0.0.1:1/odysseus-custom"));
  assert.equal(customRequest?.bearer, true);
  observations.customOrigin = {
    defaultNativeBaseUrl: codex.baseUrl,
    configuredModelBaseUrl: customModel.baseUrl,
    authBaseUrl: customAuth?.auth.baseUrl ?? null,
    actualRequest: customRequest,
    configAliasIntoFixtureBrain: true,
    fixtureHTTP400: true,
  };
  console.log(
    JSON.stringify(
      { namespace: readlinkSync("/proc/self/ns/net"), ...observations },
      null,
      2
    )
  );
} finally {
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
}
