# Lens 3: non-determinism

A test should give the same answer on every run, in any order, alone or in
company, on a busy machine or an idle one. This lens finds what makes a test's
result depend on anything but the code (rules D1 to D7 in
[the authoring guide](../../../../docs/process/test-authoring.md#determinism)).

## Read the baseline first

The `measure` output gives each file a verdict:

| Verdict | It means | Look for |
| --- | --- | --- |
| `stable` | Green in every variant | Static signals only |
| `flaky` | Sometimes red when run alone, in order | Timing, real clock, unawaited work |
| `order-dependent` | Green in order, red when its cases are shuffled | State one case leaves for another |
| `leaks-between-files` | Green alone, red when run with its cluster | Globals, env, ports, files shared across files |
| `load-sensitive` | Green when idle, red with every CPU busy | Fixed delays and tight deadlines |
| `failing` | Red every time | Not this lens: [failure issues](failure-issues.md) |
| `not-collected` | Red every time before a single case ran | Not the test: `setupError` names the cause, usually a missing `bun run build` or a load error. Fix the setup and measure again |

`--stress` is not in the default baseline because it occupies every CPU. Add
it for a file with timing signals or an open flake issue:
`bun scripts/test-health.ts measure <file> --stress --runs 5 --out <file>`.

## What to look for

| Smell | The scanner saw | The fix in one line |
| --- | --- | --- |
| `settling-sleep` | `setTimeout`, `Bun.sleep`, `waitForTimeout`, `sleep(` | Await the event the sleep was standing in for |
| `wall-clock` | `Date.now()`, `new Date()`, `performance.now()` | Inject a clock, or compare against a value the test controls |
| `unseeded-random` | `Math.random()` | Pass a fixed value or a seeded generator |
| `shared-state` | Module-level `let` or `var`; `beforeAll` without `afterAll` | Build per test, or make it `const` and immutable |
| `fixed-resource` | A hard-coded port or `/tmp/...` path | Port 0 and `mkdtemp` |
| `unrestored-global` | An assignment to `globalThis`, `window`, `navigator`, `process.env`, or `defineProperty` on one | Save the full descriptor, restore it in teardown |
| `unawaited-async` | `expect(...).resolves` or `.rejects` as a bare statement | `await` it |

`order-dependent` and `load-sensitive` come from the baseline, not the scanner.

## Classify every wait before touching it

A sleep-shaped call is not always a wait. Give each one a role from the table
in [test-waits.md](../../../../docs/process/test-waits.md), then act:

| Role | Example | Action |
| --- | --- | --- |
| Settling sleep | `await sleep(50)` then assert | Replace with the acknowledgement, saved revision or rendered state |
| Production timer or debounce | Waiting out a 600 ms policy | Advance a test clock through the registered callbacks; assert before, at and after the boundary |
| Negative observation | "Nothing was sent" after 200 ms | Keep a real opportunity for the forbidden thing: advance every relevant timer, or await a causal barrier |
| Condition poll | Loop until a state appears | Fine: it exits on the condition |
| Failure maximum | `Promise.race` against a deadline | Leave it: accepted, it costs nothing on success |
| Fixture hold | A child that sleeps until cancelled | Leave it: accepted |
| Real-time stimulus | Native media, a process freeze, slow fsync | Leave it: accepted, with the reason in the note |

A negative observation is the dangerous one. Shortening or removing the window
without an equivalent barrier turns a real check into one that cannot fail.

## Fixing

```ts
// settling-sleep: 50 ms is a guess.
save(draft);
await Bun.sleep(50);
expect(store.revision).toBe(2);
// Fixed: await what the code already signals.
await save(draft).acknowledged;
expect(store.revision).toBe(2);
```

```ts
// wall-clock: fails when the clock ticks between the two reads.
expect(entry.at).toBe(Date.now());
// Fixed: the test owns the clock.
const clock = fixedClock("2026-07-12T09:00:00Z");
expect(logEntry(clock).at).toBe(clock.now());
```

```ts
// shared-state: the second test depends on the first having run.
let ship: Ship;
test("boards", () => { ship = new Ship(); ship.board(crew); expect(ship.crew).toHaveLength(12); });
test("sails", () => { ship.sail(); expect(ship.position).toBe("sea"); });
// Fixed: each test builds what it uses.
const boarded = () => { const ship = new Ship(); ship.board(crew); return ship; };
test("boards", () => { expect(boarded().crew).toHaveLength(12); });
test("sails", () => { const ship = boarded(); ship.sail(); expect(ship.position).toBe("sea"); });
```

```ts
// unrestored-global: the next file inherits the fake.
globalThis.fetch = fakeFetch;
// Fixed: save the whole descriptor, restore it even when the test fails.
const original = Object.getOwnPropertyDescriptor(globalThis, "fetch");
afterEach(() => { if (original) Object.defineProperty(globalThis, "fetch", original); else delete (globalThis as { fetch?: unknown }).fetch; });
```

Two repository-specific traps:

- Do not wrap a promise that waits on the SQLite write worker in
  `expect(...).rejects` or `.resolves`; await it and assert on the result
  ([testing.md](../../../../docs/process/testing.md#deliberate-waits)).
- A fake clock must not race past a real socket reply or storage transaction.
  Observe the reply on the receiving side, then advance.

## Proof a fixed finding needs

Use action `deflake`. The finding needs `evidence.after`: a `measure` output of
the file after your change with at least **10 runs and no failure**, counted
across the variants you ran. Use the variants that exposed the problem:

```sh
bun scripts/test-health.ts measure <file> --runs 5 --shuffle --out <runDir>/after-<finding id>.json
# add --stress when the baseline was load-sensitive or the issue mentions load
```

Keep `evidence.before` too when you have a baseline that shows the failure; it
is what makes the improvement measurable.

## What is not yours to change

- **Timeouts and deadlines.** Raising one hides the race, and any change to one
  is a proof-system change. If a deadline is wrong, file it.
- **Retries.** Never add one.
- **What the test observes.** Do not narrow an assertion until the flake
  disappears.
- **Product timing.** If the product itself races, that is a `type: fix` issue.
