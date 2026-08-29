import { describe, expect, test } from "bun:test";
import { createPiAuth, type PiAuthRuntime } from "../src/auth";

type Interaction = Parameters<PiAuthRuntime["login"]>[2];

/**
 * A scriptable ModelRuntime slice: the test drives when the device code is
 * announced and when the login settles, mirroring the real timing (code
 * arrives mid-await, login blocks until the user approves).
 */
function makeRuntime() {
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
        i.signal?.addEventListener("abort", () =>
          reject(new Error("Login cancelled"))
        );
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
