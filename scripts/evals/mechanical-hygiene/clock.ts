/** Private brain-CLI tools only. Native Claude/auth/provider/budget clocks stay real. */
if (process.env.BRAIN_HYGIENE_CLOCK !== "2026-07-12T12:00:00Z") throw Error("Explicit private hygiene CLI clock required");
const NativeDate = Date;
const instant = NativeDate.parse(process.env.BRAIN_HYGIENE_CLOCK);
globalThis.Date = new Proxy(NativeDate, {
  construct(target, args) { return Reflect.construct(target, args.length ? args : [instant]); },
  apply() { return new NativeDate(instant).toString(); },
});
Date.now = () => instant;
// performance.now, timers, random numbers and explicit Date arguments are unchanged.
