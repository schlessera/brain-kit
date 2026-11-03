/**
 * The published ComputeProvider suite can fail (#3105): a conforming memory
 * provider passes every case, and providers that each break one promise fail
 * exactly the case named for it. The suite registers into a collector here,
 * so a failing case is an observed result, not a red run.
 */

import { expect, test } from "bun:test";

import { runComputeProviderContract, type ComputeProviderContractHarness, type ContractTestPrimitives } from "@schlessera/brain/testing";

import type { ComputeProvider } from "../src/lib/seams";
import { memoryCommands, memoryCompute, type MemoryCompute } from "./helpers/compute/memory-provider";

async function failingCases(harness: ComputeProviderContractHarness): Promise<{ ran: number; failed: string[] }> {
  const cases: { name: string; fn: () => void | Promise<void> }[] = [];
  runComputeProviderContract(harness, {
    describe: (_name, fn) => fn(),
    test: (name, fn) => void cases.push({ name, fn }),
    expect: expect as unknown as ContractTestPrimitives["expect"],
  });
  const failed: string[] = [];
  for (const c of cases) {
    try {
      await c.fn();
    } catch {
      failed.push(c.name);
    }
  }
  return { ran: cases.length, failed };
}

function harness(memory: MemoryCompute, provider: ComputeProvider = memory.provider): ComputeProviderContractHarness {
  return {
    name: provider.id,
    provider: () => provider,
    commands: memoryCommands,
    liveSandboxes: () => memory.live(),
    loseNextResponse: (m) => memory.lose(m),
    failNextTransport: (m) => memory.failTransport(m),
  };
}

test("a conforming provider passes every case", async () => {
  const result = await failingCases(harness(memoryCompute()));
  expect(result.ran).toBe(13);
  expect(result.failed).toEqual([]);
});

test("a provider that allocates twice under one idempotency key fails the idempotency case", async () => {
  const memory = memoryCompute({ capabilities: { idempotentAllocate: false } });
  const lying: ComputeProvider = { ...memory.provider, capabilities: { ...memory.provider.capabilities, idempotentAllocate: true } };
  expect((await failingCases(harness(memory, lying))).failed).toEqual(["an idempotent allocation key yields one sandbox"]);
});

test("a provider that throws on a transport failure fails the transport case", async () => {
  const memory = memoryCompute();
  const h = harness(memory);
  h.failNextTransport = (m) => memory.throwOn(m);
  expect((await failingCases(h)).failed).toEqual(["a transport failure resolves uncertain and never throws"]);
});

test("a provider that forwards the secret into the sandbox fails the secret case", async () => {
  const memory = memoryCompute();
  const leaking: ComputeProvider = {
    ...memory.provider,
    exec: (sandbox, command, ctx) => memory.provider.exec(sandbox, { ...command, env: { ...command.env, VENDOR_TOKEN: ctx.secret ?? "" } }, ctx),
  };
  expect((await failingCases(harness(memory, leaking))).failed).toEqual(["the secret reaches neither the sandbox environment nor any outcome"]);
});

test("a provider that drops the exit code fails the exit-code case", async () => {
  const memory = memoryCompute();
  const dropping: ComputeProvider = {
    ...memory.provider,
    poll: async (handle, ctx) => {
      const status = await memory.provider.poll(handle, ctx);
      return status.kind === "exited" && status.reason === "exited" ? { ...status, code: 0 } : status;
    },
  };
  expect((await failingCases(harness(memory, dropping))).failed).toEqual(["exit codes are reported as the command returned them"]);
});

test("a provider whose discard release keeps the sandbox fails the release case", async () => {
  const memory = memoryCompute();
  const keeping: ComputeProvider = { ...memory.provider, release: async () => ({ kind: "released" }) };
  const failed = (await failingCases(harness(memory, keeping))).failed;
  expect(failed).toContain("a discard release removes the sandbox and a second release is not an error");
});

test("a provider that reports unknown cost as zero fails the cost case", async () => {
  const memory = memoryCompute();
  const zero: ComputeProvider = { ...memory.provider, usage: async () => ({ usd: 0, seconds: null, coverage: "unknown" }) };
  expect((await failingCases(harness(memory, zero))).failed).toEqual(["unknown cost is null, never zero"]);
});
