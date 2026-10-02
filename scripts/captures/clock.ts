import { REFERENCE_INSTANT } from "../../packages/ui-kit/fixtures/time.ts";
// Fixture processes only. Timers and performance.now remain real so deadlines work.
const NativeDate = Date;
const instant = REFERENCE_INSTANT.getTime();
globalThis.Date = new Proxy(NativeDate, {
  construct(target, args) { return Reflect.construct(target, args.length ? args : [instant]); },
  apply() { return new NativeDate(instant).toString(); },
});
Date.now = () => instant;
let seed = 0x0d19;
Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
