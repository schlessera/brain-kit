/**
 * Test watchdogs scale under known load (#4191).
 *
 * A watchdog is a timeout that exists to stop a hang and clean up. It is a
 * catch-all for the worst case, so a run that applies CPU load on purpose
 * multiplies it by that run's factor instead of letting an honest slow test
 * trip it. The `determinism` gate is such a run: it sets the factor in the
 * environment of the tests it repeats (scripts/test-determinism.ts), and the
 * owner of the number is `DETERMINISM_PARTITIONS.deadlineFactor`
 * (scripts/proof-shards.ts). Everywhere else the factor is one and nothing
 * here changes a duration.
 *
 *   import { watchdogMs } from "../scripts/test-deadlines";
 *   const watchdog = setTimeout(stopEverything, watchdogMs(27_000));
 *
 * A product timing (a hold the product promises, a readiness limit) is not a
 * watchdog and never goes through this module: it is asserted on measured or
 * controlled time. Policy: docs/decisions/ci-utility.md, "Test watchdogs are a
 * worst-case catch-all".
 */

/** Set by a run that applies load on purpose; a whole number from 1 to 100. */
export const DEADLINE_FACTOR_ENV = "BRAIN_TEST_DEADLINE_FACTOR";
export const MAX_DEADLINE_FACTOR = 100;

/** A factor as the owner, the command line or the environment gives it. Anything else is refused, never read as one. */
export function parseDeadlineFactor(value: unknown): number {
  const factor = typeof value === "number" ? value : typeof value === "string" && /^[1-9]\d{0,2}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(factor) || factor < 1 || factor > MAX_DEADLINE_FACTOR)
    throw new Error(`The test deadline factor is a whole number from 1 to ${MAX_DEADLINE_FACTOR}: ${JSON.stringify(value)}`);
  return factor;
}

/** The factor of this process's run: one unless a loaded run set it. */
export function deadlineFactor(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env[DEADLINE_FACTOR_ENV];
  return raw === undefined || raw === "" ? 1 : parseDeadlineFactor(raw);
}

/** A watchdog's duration for this run: the written milliseconds times the run's factor. */
export function watchdogMs(milliseconds: number, env: Readonly<Record<string, string | undefined>> = process.env): number {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw new Error("A watchdog is a positive, finite number of milliseconds");
  return milliseconds * deadlineFactor(env);
}

type Registrar = (...args: unknown[]) => unknown;

const scaledOption = (value: unknown, factor: number): unknown => {
  if (typeof value === "number") return Number.isFinite(value) ? value * factor : value;
  if (value !== null && typeof value === "object" && typeof (value as { timeout?: unknown }).timeout === "number") {
    const timeout = (value as { timeout: number }).timeout;
    return { ...value, timeout: Number.isFinite(timeout) ? timeout * factor : timeout };
  }
  return value;
};

/**
 * A `bun:test` registrar (`test`, `it`, a hook) whose explicit timeout is
 * multiplied by `factor`. The timeout is the number, or the `timeout` of the
 * options object, beside the body: `test(name, body, 5000)`,
 * `test(name, { timeout: 5000 }, body)`, `beforeAll(body, 5000)`. `bodyFrom`
 * is the first position a body may take, one for a test (the name is first)
 * and zero for a hook. A call with no body there (`test.each(table)`,
 * `test.if(condition)`) is passed through and what it returns is wrapped, as
 * is every function-valued property (`test.only`, `test.skip.each`).
 */
export function scaledRegistrar<T extends object>(target: T, factor: number, bodyFrom: number): T {
  const targets = new WeakMap<object, object>(), proxies = new WeakMap<object, object>();
  const wrap = (registrar: object): object => {
    const known = proxies.get(registrar);
    if (known) return known;
    const proxy = new Proxy(registrar, {
      apply(fn, self, args: unknown[]) {
        const body = args.findIndex((arg, index) => index >= bodyFrom && typeof arg === "function");
        const scaled = body < 0 ? args : args.map((arg, index) => index >= bodyFrom && index !== body ? scaledOption(arg, factor) : arg);
        // Bun checks the receiver's class, so a chained call needs the registrar itself, not its proxy.
        const result = Reflect.apply(fn as Registrar, (self !== null && typeof self === "object" || typeof self === "function") ? targets.get(self) ?? self : self, scaled);
        return typeof result === "function" ? wrap(result) : result;
      },
      get(fn, key) {
        const value = Reflect.get(fn, key, fn);
        if (typeof value !== "function") return value;
        // A proxy must report a frozen data property unchanged.
        const own = Reflect.getOwnPropertyDescriptor(fn, key);
        return own && "value" in own && !own.configurable && !own.writable ? value : wrap(value);
      },
    });
    targets.set(proxy, registrar); proxies.set(registrar, proxy);
    return proxy;
  };
  return wrap(target) as T;
}

const TESTS = ["test", "it"] as const, HOOKS = ["beforeAll", "beforeEach", "afterAll", "afterEach"] as const;

/**
 * A copy of a `bun:test` module whose registrars multiply explicit timeouts by
 * `factor`, and whose `setDefaultTimeout` does the same for a file-wide
 * default. Everything else is the module's own. The originals are read here,
 * before the copy replaces the module: afterwards the module's own bindings
 * are the scaled ones, and a wrapper that looked itself up would never return.
 */
export function scaledTestModule(real: Readonly<Record<string, unknown>>, factor: number): Record<string, unknown> {
  parseDeadlineFactor(factor);
  const scaled: Record<string, unknown> = { ...real };
  for (const name of TESTS) scaled[name] = scaledRegistrar(real[name] as object, factor, 1);
  for (const name of HOOKS) scaled[name] = scaledRegistrar(real[name] as object, factor, 0);
  const setDefault = real.setDefaultTimeout as (milliseconds: number) => void;
  scaled.setDefaultTimeout = (milliseconds: number) => setDefault(Number.isFinite(milliseconds) ? milliseconds * factor : milliseconds);
  if ("default" in real) scaled.default = scaled;
  return scaled;
}
