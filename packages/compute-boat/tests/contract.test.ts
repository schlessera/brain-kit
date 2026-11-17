/**
 * The shipped `computeProvider` passes both shared conformance suites from
 * @schlessera/brain/testing against the in-process fake Boat: no socket, no
 * vendor, no real key.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runComputeLifecycleContract, runComputeProviderContract } from "@schlessera/brain/testing";

import { computeProvider } from "../src/index";
import { MAX_ATTEMPTS } from "../src/client";
import { boatCommands, fakeBoat } from "./helpers/fake-boat";

const primitives = { describe, test, expect } as Parameters<typeof runComputeProviderContract>[1];
const SECRET = "boat_odysseus_contract_key_9c2e";
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "brain-compute-boat-")));
let states = 0;
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const fake = fakeBoat({ apiKey: SECRET });
const harness = {
  name: "boat (fake transport)",
  provider: () => computeProvider,
  context: () => ({ secret: SECRET, fetch: fake.fetch, options: {} }),
  commands: boatCommands,
  liveSandboxes: () => fake.liveSandboxes(),
  // An allocation retries up to MAX_ATTEMPTS requests, so its fault covers the whole call.
  loseNextResponse: () => fake.failNext("create", "lose-response", MAX_ATTEMPTS),
  // A poll is sent once and never retried: a deeper queue would outlive the call and fail a later test's poll.
  failNextTransport: (method: "allocate" | "poll") =>
    method === "allocate" ? fake.failNext("create", "network", MAX_ATTEMPTS) : fake.failNext("command-status", "network", 1),
  stateDir: () => realpathSync(mkdtempSync(join(scratch, `state-${states++}-`))),
};

runComputeProviderContract(harness, primitives);
runComputeLifecycleContract(harness, primitives);

test("the conformance runs never resumed a sandbox and never left one behind", () => {
  expect(fake.routes()).not.toContain("resume");
  expect(fake.liveSandboxes()).toBe(0);
});
