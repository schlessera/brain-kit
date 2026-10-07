import { afterAll, describe, expect, mock, test } from "bun:test";
import type {
  AsrClient,
  AsrClientFactory,
  AsrClientOptions,
  RendererPack,
  VoiceSessionResponse,
} from "@schlessera/brain-ui-sdk/client";

const CHILD_MARKER = "BRAIN_UI_REACT_REGISTRATION_TEST_CHILD";
const childMode = process.env[CHILD_MARKER];

async function runIsolated(mode: "behavior" | "counts"): Promise<void> {
  const proc = Bun.spawn(
    ["bun", "test", import.meta.path, "--timeout", "30000"],
    {
      cwd: import.meta.dir,
      env: { ...process.env, [CHILD_MARKER]: mode },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `Isolated ${mode} registration tests failed (${exitCode})\n${stdout}${stderr}`
    );
  }
}

if (!childMode) {
  test("registration behavior passes in an isolated process", () =>
    runIsolated("behavior"));
  test("registration counts pass in an isolated process", () =>
    runIsolated("counts"));
} else if (childMode === "behavior") {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const { cleanup } = await import("@testing-library/react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const harness = await import("./registration-on-mount-harness.js");

  const session = (providerId: string): VoiceSessionResponse => ({
    providerId,
    url: "",
    expiresAt: Date.now() + 60_000,
    capabilities: {
      streaming: true,
      interimResults: true,
      keyterms: false,
      endpointing: false,
    },
  });
  const asrOptions = (providerId: string): AsrClientOptions => ({
    session: session(providerId),
    onEvent: () => {},
    onError: () => {},
  });

  describe("built-in registration lifecycle", () => {
    test("component and hook imports are inert", () => {
      expect(
        harness.resolveToolRenderer(
          { id: "t1", name: "Bash", input: {} },
          "claude"
        )
      ).toBeNull();
      expect(() => harness.createAsrClient(asrOptions("webspeech"))).toThrow(
        /registered: none/
      );
    });

    test("the first render synchronously registers renderers and ASR clients", () => {
      const toolCall = {
        id: "t1",
        name: "Write",
        input: { file_path: "notes/example.md", content: "hello" },
        inputJson: '{"file_path":"notes/example.md","content":"hello"}',
        status: "complete" as const,
      };

      // renderToStaticMarkup runs the render pass and NOTHING else: no effects,
      // no layout effects, no commit. So this markup is produced by whatever the
      // registry held DURING the first render — the exact timing U16 requires.
      //
      // The signal is the icon, not the summary text. An unregistered timeline
      // still renders, falling back to GENERIC_RENDERER, and the generic tier
      // sniffs shapes well enough to produce the same summary and the same
      // touched-file count. The two tiers differ in their icon: the Claude
      // pack's Write renderer draws `file-plus`, the generic renderer draws
      // `file-text`. Asserting on the summary instead would pass with an empty
      // registry, which is how this test failed to guard anything before.
      const markup = renderToStaticMarkup(
        <harness.ToolCallTimeline toolCalls={[toolCall]} onApproval={() => {}} live />
      );
      expect(markup).toContain("lucide-file-plus");
      expect(markup).not.toContain("lucide-file-text");

      let client: AsrClient | undefined;
      function DictationProbe() {
        harness.useDictation();
        client = harness.createAsrClient(asrOptions("webspeech"));
        return null;
      }
      renderToStaticMarkup(<DictationProbe />);
      expect(client).toBeInstanceOf(harness.WebSpeechClient);
    });

    test("every built-in renderer and ASR provider resolves", () => {
      for (const pack of [harness.claudeToolPack, harness.piToolPack]) {
        expect(pack.renderers.length).toBeGreaterThan(0);
        for (const renderer of pack.renderers) {
          expect(typeof renderer.match).toBe("string");
          if (typeof renderer.match !== "string") continue;
          expect(
            harness.resolveToolRenderer(
              { id: `tool-${renderer.match}`, name: renderer.match, input: {} },
              pack.backend ?? ""
            )
          ).toBe(renderer);
        }
      }

      expect(harness.createAsrClient(asrOptions("deepgram"))).toBeInstanceOf(
        harness.DeepgramClient
      );
      expect(harness.createAsrClient(asrOptions("webspeech"))).toBeInstanceOf(
        harness.WebSpeechClient
      );
    });
  });

  afterAll(async () => {
    cleanup();
    await GlobalRegistrator.unregister();
  });
} else if (childMode === "counts") {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const sdk = await import("@schlessera/brain-ui-sdk/internal/client");
  const realSdk = { ...sdk };
  const realRegisterToolRenderers = realSdk.defaultToolRendererRegistry.register;
  const realRegisterAsrClient = realSdk.defaultAsrClientRegistry.register;
  const registerToolRenderers = mock((pack: RendererPack) =>
    realRegisterToolRenderers(pack)
  );
  const registerAsrClient = mock(
    (providerId: string, factory: AsrClientFactory) =>
      realRegisterAsrClient(providerId, factory)
  );

  sdk.defaultToolRendererRegistry.register = registerToolRenderers;
  sdk.defaultAsrClientRegistry.register = registerAsrClient;

  const React = await import("react");
  const { cleanup, render, renderHook } = await import("@testing-library/react");
  const harness = await import("./registration-on-mount-harness.js");

  test("StrictMode renders and explicit repeats register each built-in once", () => {
    // "Once" is a property of the REGISTRIES, not of a module latch: renderer
    // packs dedupe by object identity and ASR factories by providerId, so
    // repeat calls are harmless AND a reset can undo them. What must hold is
    // that each repeat passes the SAME pack objects and provider ids — a
    // helper that built a fresh pack per call would stack duplicate predicates
    // in the real registry, and this is the only place that would catch it.
    const strictTimeline = render(
      <React.StrictMode>
        <harness.ToolCallTimeline toolCalls={[]} onApproval={() => {}} />
      </React.StrictMode>
    );
    const strictDictation = renderHook(() => harness.useDictation(), {
      wrapper: React.StrictMode,
    });

    harness.registerBuiltinRenderers();
    harness.registerBuiltinRenderers();
    harness.registerAsrClients();
    harness.registerAsrClients();

    const packs = registerToolRenderers.mock.calls.map(
      ([pack]: [RendererPack]) => pack
    );
    const distinct = [...new Set(packs)];
    // The contract-bound pack registers first and is deliberately unscoped:
    // the same tool carries a different name on each backend, so it matches by
    // name rather than by which backend owns the session.
    expect(distinct.map((pack) => pack.backend ?? "global")).toEqual([
      "global",
      "claude",
      "pi",
      "global",
    ]);
    expect(distinct[0]).toBe(harness.brainUiToolPack);
    expect(distinct[1]).toBe(harness.claudeToolPack);
    expect(distinct[2]).toBe(harness.piToolPack);
    // Every repeat passed one of those same three objects; a pack rebuilt per
    // call would show up as a fourth distinct object above.
    expect(packs.every((pack) => distinct.includes(pack))).toBe(true);

    const providers = registerAsrClient.mock.calls.map(
      ([providerId]: [string, AsrClientFactory]) => providerId
    );
    expect([...new Set(providers)]).toEqual(["deepgram", "webspeech"]);

    strictDictation.unmount();
    strictTimeline.unmount();
  });

  afterAll(async () => {
    cleanup();
    await GlobalRegistrator.unregister();
  });
}
