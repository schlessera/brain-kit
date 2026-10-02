// Run the real CLI/runner with every board's parser replaced, including boards
// an incorrect fallback would select. Keep registry construction and selection.
import { spyOn } from "bun:test";
import { pathToFileURL } from "node:url";

const source = process.env.JOBS_FIXTURE_SOURCE ?? new URL("../../src/", import.meta.url).pathname;
const { ALL_SOURCES } = await import(pathToFileURL(`${source}/types.ts`).href);
const { getAdapter } = await import(pathToFileURL(`${source}/scrape.ts`).href);
for (const board of ALL_SOURCES) {
  Object.getPrototypeOf(getAdapter(board)).scrapePages = async () => ({
    items: [], errors: [], status: "empty",
  });
}
const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() => {
  throw new Error("default-board fixture must not fetch");
}) as unknown as typeof fetch);
const spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => {
  throw new Error("default-board fixture must not launch a subprocess");
});
process.on("exit", () => {
  if (fetchSpy.mock.calls.length || spawnSpy.mock.calls.length) {
    console.error("default-board fixture attempted network or subprocess access");
    process.exitCode = 1;
  }
});
