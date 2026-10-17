/** Isolated process: replace only the shared native-library loader. */
import { expect, mock } from "bun:test";
const ffi = await import("bun:ffi");
let calls = 0;
mock.module("bun:ffi", () => ({ ...ffi, dlopen() { calls++; throw Error("Odysseus native library unavailable"); } }));
await import("../../src/turn-runner.js");
expect(calls, "ORDINARY_CLAUDE_IMPORT_REQUIRES_NO_NATIVE_GUARD_LIBRARY").toBe(0);
const { retainNativeRouteInputs } = await import("../../src/native-route-inputs.js");
const concurrent = await Promise.allSettled([retainNativeRouteInputs("/tmp"), retainNativeRouteInputs("/tmp")]);
expect(concurrent.map(result => result.status), "CONCURRENT_NATIVE_GUARD_UNAVAILABLE_REFUSED").toEqual(["rejected", "rejected"]);
expect(calls, "CONCURRENT_NATIVE_GUARD_LOAD_SHARED").toBe(1);
await expect(retainNativeRouteInputs("/tmp"), "SELECTED_NATIVE_GUARD_LIBRARY_UNAVAILABLE_REFUSED").rejects.toThrow("Native inference settings are unreadable");
expect(calls, "FAILED_NATIVE_GUARD_LOAD_CAN_RETRY").toBe(2);
console.log(JSON.stringify({ inactiveImport: true, selectedRefused: true }));
