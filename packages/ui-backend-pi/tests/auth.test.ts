import { describe, expect, test } from "bun:test";
import { createPiAuth, type PiAuthRuntime } from "../src/auth";

type Interaction = Parameters<PiAuthRuntime["login"]>[2];

/**
 * A scriptable ModelRuntime slice: the test drives when the device code is
 * announced and when the login settles, mirroring the real timing (code
 * arrives mid-await, login blocks until the user approves).
 */
function makeRuntime(opts: { ignoreAbort?: boolean } = {}) {
  let interaction: Interaction | null = null;
  let resolveLogin!: () => void;
  let rejectLogin!: (err: Error) => void;
  const calls: string[] = [];
  const runtime: PiAuthRuntime = {
    login(providerId, _type, i) {
      calls.push(`login:${providerId}`);
      interaction = i;
      return new Promise<void>((resolve, reject) => {
        resolveLogin = resolve;
        rejectLogin = reject;
        if (!opts.ignoreAbort) {
          i.signal?.addEventListener("abort", () =>
            reject(new Error("Login cancelled"))
          );
        }
      });
    },
    async logout(providerId) {
      calls.push(`logout:${providerId}`);
    },
    getProviderAuthStatus(providerId) {
      return providerId === "openai-codex"
        ? { configured: true, source: "stored" }
        : { configured: false };
    },
    getProvider(providerId) {
      return providerId === "openai-codex"
        ? { auth: { oauth: { name: "OpenAI (ChatGPT Plus/Pro)" } } }
        : undefined;
    },
  };
  return {
    runtime,
    calls,
    get interaction() {
      return interaction!;
    },
    announceCode() {
      interaction!.notify({
        type: "device_code",
        userCode: "ABCD-1234",
        verificationUri: "https://auth.openai.com/codex/device",
        intervalSeconds: 5,
        expiresInSeconds: 900,
      });
    },
    approve: () => resolveLogin(),
    fail: (message: string) => rejectLogin(new Error(message)),
  };
}

const auth = (rt: ReturnType<typeof makeRuntime>) =>
  createPiAuth({ runtime: async () => rt.runtime });

describe("createPiAuth", () => {
  test("status maps configured/oauth/name per provider", async () => {
    const rt = makeRuntime();
    const statuses = await auth(rt).status(["openai-codex", "openai"]);
    expect(statuses).toEqual([
      {
        providerId: "openai-codex",
        name: "OpenAI (ChatGPT Plus/Pro)",
        configured: true,
        source: "stored",
        oauth: true,
      },
      { providerId: "openai", name: "openai", configured: false, oauth: false },
    ]);
  });

  test("startLogin returns once the device code is known; approval completes the flow", async () => {
    const rt = makeRuntime();
    const service = auth(rt);
    const started = service.startLogin("openai-codex");
    // Let login() run and answer the method prompt with the device flow.
    await Bun.sleep(0);
    await expect(
      rt.interaction.prompt({
        type: "select",
        message: "How do you want to sign in?",
        options: [
          { id: "browser", label: "Browser" },
          { id: "device_code", label: "Device code" },
        ],
      })
    ).resolves.toBe("device_code");

    rt.announceCode();
    const flow = await started;
    expect(flow.status).toBe("pending");
    expect(flow.userCode).toBe("ABCD-1234");
    expect(flow.verificationUri).toBe("https://auth.openai.com/codex/device");

    rt.approve();
    await Bun.sleep(0);
    expect(service.getFlow(flow.id)?.status).toBe("success");
  });

  test("a login failing before any code settles the returned flow as error", async () => {
    const rt = makeRuntime();
    const service = auth(rt);
    const started = service.startLogin("openai-codex");
    await Bun.sleep(0);
    rt.fail("usercode request failed");
    const flow = await started;
    expect(flow.status).toBe("error");
    expect(flow.error).toBe("usercode request failed");
  });

  test("a prompt the web flow cannot answer rejects with the pi-login hint", async () => {
    const rt = makeRuntime();
    const service = auth(rt);
    void service.startLogin("openai-codex");
    await Bun.sleep(0);
    await expect(
      rt.interaction.prompt({ type: "manual_code", message: "Paste the code" })
    ).rejects.toThrow("Use `pi login` on the host instead");
  });

  test("cancelFlow aborts the pending flow", async () => {
    const rt = makeRuntime();
    const service = auth(rt);
    const started = service.startLogin("openai-codex");
    await Bun.sleep(0);
    rt.announceCode();
    const flow = await started;

    service.cancelFlow(flow.id);
    await Bun.sleep(0);
    expect(service.getFlow(flow.id)?.status).toBe("cancelled");
  });

  test("a new start supersedes the provider's previous pending flow", async () => {
    const rt = makeRuntime();
    const service = auth(rt);
    const first = await (async () => {
      const started = service.startLogin("openai-codex");
      await Bun.sleep(0);
      rt.announceCode();
      return started;
    })();

    const second = service.startLogin("openai-codex");
    await Bun.sleep(0);
    rt.announceCode();
    const secondFlow = await second;

    expect(service.getFlow(first.id)?.status).toBe("cancelled");
    expect(service.getFlow(secondFlow.id)?.status).toBe("pending");
  });

  test("providers without a web-drivable flow are not advertised as oauth", async () => {
    const rt = makeRuntime();
    rt.runtime.getProvider = () => ({ auth: { oauth: { name: "GitHub Copilot" } } });
    const statuses = await auth(rt).status(["github-copilot"]);
    expect(statuses[0]?.oauth).toBe(false);
    await expect(auth(rt).startLogin("github-copilot")).rejects.toThrow(
      "cannot be signed in from the web UI"
    );
  });

  test("two simultaneous starts leave exactly one pending flow", async () => {
    const rt = makeRuntime();
    const service = auth(rt);
    const a = service.startLogin("openai-codex");
    const b = service.startLogin("openai-codex");
    await Bun.sleep(0);
    rt.announceCode();
    const [flowA, flowB] = await Promise.all([a, b]);
    const statuses = [service.getFlow(flowA.id)?.status, service.getFlow(flowB.id)?.status];
    expect(statuses.filter((s) => s === "pending")).toHaveLength(1);
    expect(statuses.filter((s) => s === "cancelled")).toHaveLength(1);
  });

  test("cancel racing a just-approved login removes the persisted credential", async () => {
    // Model the real race: pi's login checks the abort signal only at poll
    // points, so an approval mid-refresh resolves the promise DESPITE a
    // just-fired abort.
    const rt = makeRuntime({ ignoreAbort: true });
    const service = auth(rt);
    const started = service.startLogin("openai-codex");
    await Bun.sleep(0);
    rt.announceCode();
    const flow = await started;

    // The user approves at the provider and hits Cancel in the same instant:
    // cancel lands first, then the login promise resolves successfully.
    service.cancelFlow(flow.id);
    rt.approve();
    await Bun.sleep(0);

    expect(service.getFlow(flow.id)?.status).toBe("cancelled");
    expect(rt.calls).toContain("logout:openai-codex");
  });

  test("logout cancels any pending flow and delegates to the runtime", async () => {
    const rt = makeRuntime();
    const service = auth(rt);
    const started = service.startLogin("openai-codex");
    await Bun.sleep(0);
    rt.announceCode();
    const flow = await started;

    await service.logout("openai-codex");
    expect(service.getFlow(flow.id)?.status).toBe("cancelled");
    expect(rt.calls).toContain("logout:openai-codex");
  });
});
