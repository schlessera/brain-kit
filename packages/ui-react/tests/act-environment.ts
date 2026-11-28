// React's act() test switch, `globalThis.IS_REACT_ACT_ENVIRONMENT`, set and
// restored the way docs/process/test-authoring.md D5 asks of any replaced
// global (#4999).
//
// `bun test` runs a package's test files in one process, and Happy DOM's
// `GlobalRegistrator.unregister()` restores only the Window properties it
// snapshotted, so a flag a helper sets would otherwise stay on for every later
// file. A helper calls `enterActEnvironment()` where it registers its DOM and
// `restoreActEnvironment()` in the `finally` of its unregister. The restore
// must be registered after the file imports `@testing-library/react`, whose
// own `afterAll` writes the flag back: Bun runs `afterAll` hooks in
// registration order.
//
// Entering is idempotent until the matching restore: a helper's module body and
// its test file both register, and the second call must not snapshot the first
// call's `true` as the original. One slot is enough because no two
// registrations overlap: a test file loads one DOM helper, and the control test
// loads them one after another.

const KEY = "IS_REACT_ACT_ENVIRONMENT";

let saved: { descriptor: PropertyDescriptor | undefined } | undefined;

/** Turn React's act environment on, remembering the descriptor it replaces. */
export function enterActEnvironment(): void {
  saved ??= { descriptor: Object.getOwnPropertyDescriptor(globalThis, KEY) };
  Object.defineProperty(globalThis, KEY, { configurable: true, enumerable: true, writable: true, value: true });
}

/** Put back the exact descriptor `enterActEnvironment` replaced, or delete one that was absent. */
export function restoreActEnvironment(): void {
  if (saved === undefined) return;
  const { descriptor } = saved;
  saved = undefined;
  if (descriptor) Object.defineProperty(globalThis, KEY, descriptor);
  else Reflect.deleteProperty(globalThis, KEY);
}
