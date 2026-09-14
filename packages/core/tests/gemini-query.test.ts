import { expect, test } from "bun:test";

// Isolate the SDK's global fetch and credentials from the rest of the suite.
// Requests use the real installed SDK but never leave this process.
test("Gemini query requests honor cancellation and do not retry rate limits", async () => {
  const providerPath = new URL("../src/providers/embeddings/gemini.ts", import.meta.url).pathname;
  const script = `
    import { geminiEmbeddings } from ${JSON.stringify(providerPath)};
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ error: { code: 429, message: "rate limited", status: "RESOURCE_EXHAUSTED" } }), { status: 429 });
    };
    const provider = geminiEmbeddings({ dimensions: 2 });
    try { await provider.embedQuery("topic"); throw new Error("expected rate limit"); }
    catch (error) { if (error.status !== 429) throw error; }
    if (calls !== 1) throw new Error("query retried");
    let receivedSignal;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    globalThis.fetch = async (_url, init) => {
      receivedSignal = init.signal;
      started();
      return new Promise((_, reject) => {
        if (init.signal.aborted) reject(init.signal.reason);
        else init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    };
    const controller = new AbortController();
    const request = provider.embedQuery("topic", { signal: controller.signal });
    await ready;
    controller.abort(new Error("cancel query"));
    let rejected = false;
    try { await request; } catch { rejected = true; }
    if (!receivedSignal.aborted || !rejected) throw new Error("cancellation did not reach fetch");
    console.log("ok");
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    timeout: 5_000,
    stdout: "pipe", stderr: "pipe", env: { ...process.env, GEMINI_API_KEY: "test-key", GOOGLE_API_KEY: "" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(stdout.trim()).toBe("ok");
});
