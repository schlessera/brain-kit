/**
 * Two independent ComputeProvider implementations pass one shared
 * conformance suite (#3105): an in-memory vendor-shaped provider and an
 * SSH-shaped local-process provider that is deliberately different
 * (non-idempotent allocation, no remote expiry, no usage). Both run the
 * provider suite and the lifecycle suite from @schlessera/brain/testing.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runComputeLifecycleContract, runComputeProviderContract } from "@schlessera/brain/testing";

import { localCommands, localProcessCompute } from "./helpers/compute/local-process-provider";
import { memoryCommands, memoryCompute } from "./helpers/compute/memory-provider";

const primitives = { describe, test, expect } as Parameters<typeof runComputeProviderContract>[1];
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "brain-compute-contracts-")));
let states = 0;
const stateDir = () => realpathSync(mkdtempSync(join(scratch, `state-${states++}-`)));

const memory = memoryCompute();
const memoryHarness = {
  name: "memory",
  provider: () => memory.provider,
  commands: memoryCommands,
  liveSandboxes: () => memory.live(),
  loseNextResponse: (m: "allocate") => memory.lose(m),
  failNextTransport: (m: "allocate" | "poll") => memory.failTransport(m),
  context: () => ({ options: { region: "ithaca" } }),
  stateDir,
};

const local = localProcessCompute(join(scratch, "local-work"));
const localHarness = {
  name: "local-process",
  provider: () => local.provider,
  commands: localCommands,
  liveSandboxes: () => local.live(),
  loseNextResponse: (m: "allocate") => local.lose(m),
  failNextTransport: (m: "allocate" | "poll") => local.failTransport(m),
  stateDir,
};

afterAll(async () => {
  await local.dispose();
  rmSync(scratch, { recursive: true, force: true });
});

runComputeProviderContract(memoryHarness, primitives);
runComputeLifecycleContract(memoryHarness, primitives);
runComputeProviderContract(localHarness, primitives);
runComputeLifecycleContract(localHarness, primitives);

test("the two implementations differ where the contract allows", () => {
  const a = memory.provider.capabilities;
  const b = local.provider.capabilities;
  expect([a.idempotentAllocate, a.remoteExpiry, a.usage]).toEqual([true, true, "actual"]);
  expect([b.idempotentAllocate, b.remoteExpiry, b.usage]).toEqual([false, false, "none"]);
});
