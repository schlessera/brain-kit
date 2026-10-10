/** Pin only a disposable CLI child's wall date; monotonic timers remain real. */
const RealDate = Date;
const FIXED = RealDate.parse("2026-07-12T12:00:00Z");
globalThis.Date = new Proxy(RealDate, {
  construct(target, args, newTarget) { return Reflect.construct(target, args.length ? args : [FIXED], newTarget); },
  apply() { return new RealDate(FIXED).toString(); },
  get(target, key, receiver) { return key === "now" ? () => FIXED : Reflect.get(target, key, receiver); },
});
