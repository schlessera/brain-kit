/** Controlled transport below an independently installed guard; never dispatches HTTP. */
import { strict as assert } from "node:assert";

const scenario = process.argv[2]!;
const clones: Request[] = [];
const uploads: Request[] = [];
const inputs: ReadableStream<Uint8Array>[] = [];
let sourceCancels = 0, responseCancels = 0, cloneCancels = 0;
const calls: { method: string; bytes: number; headers: Record<string, string> }[] = [];
const transportError = new Error("controlled transport failure");
const responseError = new Error("controlled response cancellation failure");
const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch")!;
const cloneDescriptor = Object.getOwnPropertyDescriptor(Request.prototype, "clone")!;
const originalClone = Request.prototype.clone;
const finite = scenario === "replay307" || scenario === "rewrite303";
const followed = ["replay307", "rewrite303", "open307", "rewrite-open303"].includes(scenario);
const rewrite = ["rewrite303", "rewrite-open303"].includes(scenario);
const input = (): RequestInit => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(32768).fill(73)); if (finite) controller.close(); },
    cancel() { sourceCancels++; if (scenario === "cleanup-error") throw new Error("controlled upload cancellation failure"); },
  });
  inputs.push(body);
  return {
  method: "POST", redirect: scenario === "manual" ? "manual" : scenario === "redirect-error" ? "error" : "follow",
  headers: { "content-type": "text/plain", "content-language": "en", "content-encoding": "identity",
    "content-location": "/ithaca", "content-length": "32768", authorization: "fixture", cookie: "fixture", "proxy-authorization": "fixture" },
  body,
  };
};
const transport = async (value: Parameters<typeof fetch>[0]) => {
  assert(value instanceof Request);
  // Independent sentinel stays active if refusal enforcement is mutated.
  assert(["localhost", "127.0.0.1", "[::1]"].includes(new URL(value.url).hostname), "sentinel refused external dispatch");
  uploads.push(value);
  let bytes = 0;
  if (value.body && !["unread", "transport-unread-error"].includes(scenario)) {
    if (finite) bytes = (await value.arrayBuffer()).byteLength;
    else {
      const reader = value.body.getReader();
      bytes = (await reader.read()).value?.byteLength ?? 0;
      // Awaiting this tee branch would hang until the replay owner disposes its sibling.
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  calls.push({ method: value.method, bytes, headers: Object.fromEntries(value.headers) });
  if (["transport-error", "transport-unread-error"].includes(scenario)) throw transportError;
  const redirect = ["manual", "redirect-error", "limit", "refusal", "malformed", "response-error"].includes(scenario) ||
    (followed && calls.length === 1);
  const location = scenario === "refusal" ? "https://escape.example.invalid/ithaca" : scenario === "malformed" ? "http://[" :
    "http://127.0.0.1/troy";
  return new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("Ithaca")); },
    cancel() { responseCancels++; if (scenario === "response-error") throw responseError; },
  }), { status: redirect ? rewrite ? 303 : 307 : 200, headers: redirect ? { location } : {} });
};

try {
  Object.defineProperty(globalThis, "fetch", { ...fetchDescriptor, value: transport });
  Object.defineProperty(Request.prototype, "clone", { ...cloneDescriptor, value: function (this: Request) {
    const clone = originalClone.call(this);
    clones.push(clone);
    if (clone.body) {
      const body = clone.body, cancel = body.cancel;
      Object.defineProperty(body, "cancel", { value: function (reason?: unknown) {
        cloneCancels++;
        return cancel.call(body, reason);
      } });
    }
    return clone;
  } });
  if (scenario === "direct") {
    const response = await transport(new Request("http://localhost/ithaca", input()));
    assert.equal(sourceCancels, 1, "same-input direct transport cancels open source");
    await response.body!.cancel();
  } else {
    const { installNetworkGuard } = await import("../../scripts/test-network-guard");
    const guard = installNetworkGuard();
    let response: Response | undefined, failure: unknown;
    try {
      response = await fetch("http://localhost/ithaca", { ...input(), ...(scenario === "proxy" ? { proxy: "http://proxy.example.invalid" } : {}) });
    } catch (error) { failure = error; }
    // Bounded scheduling drain, not a memory/GC measurement.
    await new Promise(resolve => setTimeout(resolve, 0));
    if (scenario === "proxy" || scenario === "refusal") {
      assert.match(String(failure), /Offline test guard/);
      assert.throws(() => guard.assertNoEscapes(), /Offline test guard/, "caught escapes remain visible to hooks");
    } else guard.assertNoEscapes();
    if (scenario === "proxy") {
      assert.equal(calls.length, 0); assert.equal(clones.length, 0);
    } else {
      if (["unread", "transport-unread-error"].includes(scenario)) {
        assert.equal(sourceCancels, 0, "transport still owns the unread sibling");
        await uploads[0]!.body!.cancel();
        assert.equal(sourceCancels, 1, "both disposed branches release the source");
      } else if (!finite) assert.equal(sourceCancels, 1, "unused replay disposal must release stopped open upload");
      const consumed = ["replay307", "open307"].includes(scenario) ? 1 : scenario === "limit" ? 20 : 0;
      assert.equal(cloneCancels, clones.filter(clone => clone.body !== null).length - consumed, "every unused replay body is cancelled");
      if (["transport-error", "transport-unread-error"].includes(scenario)) assert.equal(failure, transportError);
      else if (scenario === "response-error") assert.equal(failure, responseError);
      else if (scenario === "redirect-error") assert.match(String(failure), /redirect mode is error/);
      else if (scenario === "limit") { assert.match(String(failure), /more than 20 times/); assert.equal(calls.length, 21); }
      else if (scenario === "malformed") assert(failure instanceof TypeError);
      else if (scenario !== "refusal") {
        assert.equal(failure, undefined);
        assert(response);
        assert.equal(responseCancels, followed ? 1 : 0, "returned response body remains caller-owned");
        assert.equal(response.status, scenario === "manual" ? 307 : 200);
        assert.equal(response.redirected, followed);
        const reader = response.body!.getReader();
        assert.equal(new TextDecoder().decode((await reader.read()).value), "Ithaca");
        await reader.cancel();
        if (followed) {
          assert.deepEqual(calls.map(call => [call.method, call.bytes]), !rewrite ? [["POST", 32768], ["POST", 32768]] : [["POST", 32768], ["GET", 0]]);
          for (const name of ["authorization", "cookie", "proxy-authorization"]) assert.equal(calls[1]!.headers[name], undefined);
          for (const name of ["content-type", "content-length", "content-encoding", "content-language", "content-location"]) {
            assert.equal(calls[1]!.headers[name], rewrite ? undefined : calls[0]!.headers[name]);
          }
        } else assert.equal(calls.length, 1);
      }
    }
  }
  console.log("REPLAY_PROBE_OK=" + scenario);
  // Refusals must still override an explicit successful ordinary child exit.
  if (scenario === "proxy" || scenario === "refusal") process.exit(0);
} finally {
  // Diagnostic teardown releases observed branches even on the original-source red.
  for (const clone of [...clones, ...uploads]) if (clone.body && !clone.body.locked && !clone.bodyUsed) void clone.body.cancel().catch(() => {});
  for (const body of inputs) if (!body.locked) void body.cancel().catch(() => {});
  Object.defineProperty(Request.prototype, "clone", cloneDescriptor);
  Object.defineProperty(globalThis, "fetch", fetchDescriptor);
}
