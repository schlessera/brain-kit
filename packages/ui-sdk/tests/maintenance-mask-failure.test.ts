import { expect, spyOn, test } from "bun:test";
import { reportMaintenanceMaskFailure } from "../src/server/maintenance-mask-failure";

function capture(action: () => void) {
  const values: unknown[][] = [], logging = spyOn(console, "error").mockImplementation((...args) => { values.push(args); });
  try { action(); } finally { logging.mockRestore(); }
  expect(values).toHaveLength(1); expect(values[0]).toHaveLength(1);
  expect(typeof values[0]![0]).toBe("string");
  return { text: values[0]![0] as string, value: JSON.parse(values[0]![0] as string).nativeMaintenanceMaskFailure };
}

test("mask refusal logging emits only fixed fields and distinguishes actual abort-reason identity", () => {
  const reason = Object.assign(new Error("Odysseus private abort text"), { code: "EACCES" });
  const controller = new AbortController(); controller.abort(reason);
  const { value, text } = capture(() => reportMaintenanceMaskFailure("masks", reason, controller.signal));
  expect(value).toEqual({ phase: "masks", errorClass: "Error", errno: "EACCES", providedSignalAborted: true, errorIsProvidedAbortReason: true });
  expect(text).not.toContain(reason.message);
  const coincident = capture(() => reportMaintenanceMaskFailure("post-current", new TypeError("Odysseus other private text"), controller.signal));
  expect(coincident.value).toEqual({ phase: "post-current", errorClass: "TypeError", errno: "unknown", providedSignalAborted: true, errorIsProvidedAbortReason: false });
});

test("untrusted error names, codes, phases and extra properties never become diagnostic bytes", () => {
  const secret = "Odysseus-private-error-token";
  const error = { name: secret, code: secret, message: secret, stack: secret, path: secret, extra: secret };
  const { text, value } = capture(() => reportMaintenanceMaskFailure(secret, error));
  expect(text, "MASK_FAILURE_RAW_DATA_NOT_LOGGED").not.toContain(secret);
  expect(value).toEqual({ phase: "unknown", errorClass: "unknown", errno: "unknown", providedSignalAborted: false, errorIsProvidedAbortReason: false });
  expect(Buffer.byteLength(text)).toBeLessThan(512);
});

test("throwing error getters and proxies are bounded without inspecting messages or enumerating properties", () => {
  const accessed: PropertyKey[] = [];
  const hostile = new Proxy({}, {
    get(_target, key) { accessed.push(key); throw Error("Odysseus private getter failure"); },
    ownKeys() { throw Error("Error properties must never be enumerated"); },
  });
  const { value, text } = capture(() => reportMaintenanceMaskFailure("pre-current", hostile));
  expect(accessed).toEqual(["name", "code"]);
  expect(value).toEqual({ phase: "pre-current", errorClass: "unknown", errno: "unknown", providedSignalAborted: false, errorIsProvidedAbortReason: false });
  expect(text).not.toContain("Odysseus");
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  expect(capture(() => reportMaintenanceMaskFailure("context", revoked.proxy)).value.errorClass).toBe("unknown");
});

test("failed stderr writes and hostile signal access cannot throw from failure observability", () => {
  const logging = spyOn(console, "error").mockImplementation(() => { throw Error("Odysseus stderr unavailable"); });
  try { expect(() => reportMaintenanceMaskFailure("store", new Error("Odysseus original failure")), "MASK_DIAGNOSTIC_NEVER_REPLACES_REFUSAL").not.toThrow(); }
  finally { logging.mockRestore(); }
  const signal = new Proxy({}, { get() { throw Error("Odysseus signal getter"); } }) as AbortSignal;
  expect(capture(() => reportMaintenanceMaskFailure("pre-abort", null, signal)).value).toEqual({
    phase: "pre-abort", errorClass: "unknown", errno: "unknown", providedSignalAborted: false, errorIsProvidedAbortReason: false,
  });
});
