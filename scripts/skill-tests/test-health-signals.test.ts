import { describe, expect, test } from "bun:test";
import { SMELLS, smellById } from "../test-health/catalog";
import { countSignals, scanSource, signalWeight } from "../test-health/signals";

const HEADER = 'import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";\n';
const scan = (body: string) => scanSource("packages/ithaca/tests/oars.test.ts", HEADER + body);
const smells = (body: string) => countSignals(scan(body).signals);
/** The line a smell is reported on, counted within `body`. */
const lineOf = (body: string, smell: string) => scan(body).signals.find(signal => signal.smell === smell)!.line - 1;

describe("the static scanner reports each smell on the test that carries it", () => {
  const cases: Array<[smell: string, source: string, clean: string]> = [
    ["no-assertion",
      'test("rows the ship", () => { const oars = 12; void oars; });',
      'test("rows the ship", () => { expect(12).toBeGreaterThan(1); });'],
    ["weak-matcher",
      'test("finds a crew", () => { expect(crew()).toBeDefined(); });',
      'test("finds a crew", () => { expect(crew()).toEqual(["Eurylochus"]); });'],
    ["not-throw-only",
      'test("sets sail", () => { expect(() => sail()).not.toThrow(); });',
      'test("sets sail", () => { expect(() => sail()).not.toThrow(); expect(position()).toBe("Ithaca"); });'],
    ["conditional-assertion",
      'test("counts the suitors", () => { if (suitors.length) { expect(suitors.length).toBe(108); } });',
      'test("counts the suitors", () => { expect(suitors.length).toBe(108); });'],
    ["self-comparison",
      'test("keeps the bow", () => { expect(bow).toBe(bow); });',
      'test("keeps the bow", () => { expect(bow).toBe(greatBow); });'],
    ["asserts-the-double",
      'test("calls the herald", () => { herald(); expect(spy).toHaveBeenCalledTimes(1); });',
      'test("calls the herald", () => { herald(); expect(spy).toHaveBeenCalledTimes(1); expect(heard()).toBe("Medon"); });'],
    ["settling-sleep",
      'test("waits for the tide", async () => { await new Promise(resolve => setTimeout(resolve, 50)); expect(tide()).toBe("high"); });',
      'test("waits for the tide", async () => { await tideTurned(); expect(tide()).toBe("high"); });'],
    ["real-time-wait",
      'test("waits a watch", async () => { await Bun.sleep(1500); expect(watch()).toBe(2); });',
      'test("waits a watch", async () => { await Bun.sleep(15); expect(watch()).toBe(2); });'],
    ["wall-clock",
      'test("stamps the log", () => { expect(entry().at).toBeLessThanOrEqual(Date.now()); });',
      'test("stamps the log", () => { expect(entry(clock).at).toBe(clock.now()); });'],
    ["unseeded-random",
      'test("draws lots", () => { expect(draw(Math.random())).toBeLessThan(12); });',
      'test("draws lots", () => { expect(draw(0.25)).toBe(3); });'],
    ["shared-state",
      'let ship: unknown;\ntest("boards", () => { expect(ship).toBe(undefined); });',
      'const ship = 1;\ntest("boards", () => { expect(ship).toBe(1); });'],
    ["fixed-resource",
      'test("opens the harbour", () => { const server = listen({ port: 4321 }); expect(server.port).toBe(4321); });',
      'test("opens the harbour", () => { const server = listen({ port: 0 }); expect(server.port).toBeGreaterThan(0); });'],
    ["unrestored-global",
      'test("fakes the wind", () => { globalThis.fetch = fakeWind; expect(typeof fetch).toBe("function"); });',
      'test("fakes the wind", () => { const wind = fakeWind; expect(typeof wind).toBe("function"); });'],
    ["unawaited-async",
      'test("reaches Ithaca", async () => { expect(voyage()).resolves.toBe("Ithaca"); });',
      'test("reaches Ithaca", async () => { await expect(voyage()).resolves.toBe("Ithaca"); });'],
    ["skipped",
      'test.skip("passes the sirens", () => { expect(heard()).toBe(false); });',
      'test("passes the sirens", () => { expect(heard()).toBe(false); });'],
    ["conditional-skip",
      'test.skipIf(!calm)("crosses the strait", () => { expect(crossed()).toBe(6); });',
      'test("crosses the strait", () => { expect(crossed()).toBe(6); });'],
    ["retry",
      'test("threads the axes", () => { expect(shot()).toBe(12); }, { retry: 3 });',
      'test("threads the axes", () => { expect(shot()).toBe(12); });'],
    ["only",
      'test.only("strings the bow", () => { expect(strung()).toBe(1); });',
      'test("strings the bow", () => { expect(strung()).toBe(1); });'],
    ["long-timeout",
      'test("sails home", () => { expect(home()).toBe("Ithaca"); }, 120000);',
      'test("sails home", () => { expect(home()).toBe("Ithaca"); }, 5000);'],
    ["opaque-failure",
      'test("names the island", () => { expect(island() === "Ithaca").toBe(true); });',
      'test("names the island", () => { expect(island()).toBe("Ithaca"); });'],
    ["unclear-name",
      'test("works", () => { expect(island()).toBe("Ithaca"); });',
      'test("names the island", () => { expect(island()).toBe("Ithaca"); });'],
    ["duplicate-case",
      'test("names the island", () => { expect(island()).toBe("Ithaca"); });\ntest("names the island", () => { expect(island()).toBe("Ithaca"); });',
      'test("names the island", () => { expect(island()).toBe("Ithaca"); });\ntest("names the king", () => { expect(king()).toBe("Odysseus"); });'],
    ["matrix-multiplier",
      'for (const theme of themes) { for (const width of widths) { test(`${theme} ${width}`, () => { expect(render(theme, width)).toBe(1); }); } }',
      'for (const width of widths) { test(`${width}`, () => { expect(render(width)).toBe(1); }); }'],
    ["per-test-setup",
      'beforeEach(() => { Bun.spawnSync(["git", "init"]); });\ntest("commits", () => { expect(head()).toBe("main"); });',
      'beforeAll(() => { Bun.spawnSync(["git", "init"]); });\ntest("commits", () => { expect(head()).toBe("main"); });'],
    ["leaked-resource",
      'test("moors", () => { const dir = mkdtempSync("ithaca-"); expect(dir).toContain("ithaca"); });',
      'afterEach(() => cleanup());\ntest("moors", () => { const dir = mkdtempSync("ithaca-"); expect(dir).toContain("ithaca"); });'],
  ];

  test.each(cases)("%s", (smell, source, clean) => {
    expect(smellById(smell)?.detect, `${smell} is a static smell in the catalogue`).toBe("static");
    expect(smells(source)[smell] ?? 0).toBeGreaterThanOrEqual(1);
    expect(smells(clean)[smell] ?? 0).toBe(0);
  });

  test("every static smell in the catalogue has a scanner case", () => {
    // Three are file-level and tested below; `undiscovered` comes from the inventory, not from syntax.
    const covered = new Set([...cases.map(([smell]) => smell), "spawn-per-assertion", "over-mocked", "giant-test", "undiscovered"]);
    expect(SMELLS.filter(entry => entry.detect === "static").map(entry => entry.id).filter(id => !covered.has(id))).toEqual([]);
  });
});

describe("file-level signals", () => {
  test("many spawn sites are one signal with their count", () => {
    const body = `test("runs the fleet", () => {\n${Array.from({ length: 6 }, (_, i) => `  Bun.spawnSync(["ship", "${i}"]);`).join("\n")}\n  expect(fleet()).toBe(6);\n});`;
    const found = scan(body).signals.filter(signal => signal.smell === "spawn-per-assertion");
    expect(found).toEqual([{ smell: "spawn-per-assertion", line: 3, detail: "6 spawn sites" }]);
  });

  test("more doubles than assertions is over-mocked, and an equal number is not", () => {
    const doubles = (count: number) => Array.from({ length: count }, (_, i) => `const spy${i} = mock(() => ${i});`).join("\n");
    expect(smells(`${doubles(5)}\ntest("sails", () => { expect(1).toBe(one()); });`)["over-mocked"]).toBe(1);
    const asserts = Array.from({ length: 5 }, (_, i) => `expect(${i}).toBe(value(${i}));`).join(" ");
    expect(smells(`${doubles(5)}\ntest("sails", () => { ${asserts} });`)["over-mocked"]).toBeUndefined();
  });

  test("a test body over the size limit is a giant test", () => {
    const body = `test("retells the voyage", () => {\n${Array.from({ length: 151 }, (_, i) => `  expect(book(${i})).toBe(${i});`).join("\n")}\n});`;
    expect(smells(body)["giant-test"]).toBe(1);
  });
});

describe("judgment the scanner leaves alone", () => {
  test("a catch-only assertion is sound when the try block fails the test on success", () => {
    const guarded = 'test("refuses the suitor", async () => { try { await enter(); expect.unreachable(); } catch (error) { expect(String(error)).toContain("refused"); } });';
    const unguarded = 'test("refuses the suitor", async () => { try { await enter(); } catch (error) { expect(String(error)).toContain("refused"); } });';
    expect(smells(guarded)["conditional-assertion"]).toBeUndefined();
    expect(smells(unguarded)["conditional-assertion"]).toBe(1);
  });

  test("a helper that may assert lowers the weight of a missing assertion instead of hiding it", () => {
    const delegated = scan('test("checks the manifest", () => { verifyManifest(cargo); });').signals;
    const bare = scan('test("checks the manifest", () => { const cargo = 1; void cargo; });').signals;
    expect(delegated.map(signal => signal.smell)).toEqual(["no-assertion"]);
    expect(signalWeight(delegated)).toBe(0.5);
    expect(signalWeight(bare)).toBe(smellById("no-assertion")!.weight);
  });

  test("a helper named as an assertion counts as one", () => {
    expect(smells('test("checks the manifest", () => { expectManifest(cargo); });')["no-assertion"]).toBeUndefined();
  });

  test("a skip stored in a variable is a conditional skip", () => {
    expect(smells('const live = LIVE ? test : test.skip;\nlive("reaches the provider", () => { expect(reach()).toBe(1); });')["conditional-skip"]).toBe(1);
  });

  test("a loop that holds every assertion is reported once, on the test", () => {
    const body = 'test("checks each oar", () => {\n  for (const oar of oars) {\n    expect(oar.length).toBe(4);\n  }\n});';
    expect(lineOf(body, "conditional-assertion")).toBe(1);
    expect(smells(body)["conditional-assertion"]).toBe(1);
  });

  test("every declaration is named by its describe path, and a computed title by its source text", () => {
    const result = scan([
      'describe("the voyage", () => {',
      '  describe("home", () => { test("ends", () => { expect(end()).toBe("Ithaca"); }); });',
      '  test.each([1, 2])("leg %d", leg => { expect(leg).toBeGreaterThan(0); });',
      '  for (const wind of winds) test(`sails on ${wind}`, () => { expect(sail(wind)).toBe(true); });',
      "});",
      'test("lands", () => { expect(land()).toBe(1); });',
    ].join("\n"));
    expect(result.titles).toEqual(["the voyage > home > ends", "the voyage > leg %d", "the voyage > `sails on ${wind}`", "lands"]);
  });

  test("a title keeps its name when lines above it move", () => {
    const titled = 'describe(`suite ${n}`, () => { test("ends", () => { expect(1).toBe(one()); }); });';
    expect(scan(`\n\n\n${titled}`).titles).toEqual(scan(titled).titles);
  });

  test("tests and assertions are counted through describe blocks and tables", () => {
    const result = scan('describe("the voyage", () => {\n  test.each([1, 2])("leg %d", leg => { expect(leg).toBeGreaterThan(0); });\n  test("ends", () => { expect(end()).toBe("Ithaca"); });\n});');
    expect([result.tests, result.matchers]).toEqual([2, 2]);
  });
});
