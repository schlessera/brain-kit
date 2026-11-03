/**
 * A ComputeContext for one call against a fake Boat, with a logger that keeps
 * every line, and an adapter whose waits are recorded instead of slept.
 */

import type { ComputeContext } from "@schlessera/brain";

import { createBoatProvider } from "../../src/provider";
import type { FakeBoat } from "./fake-boat";

export const KEY = "boat_odysseus_test_key_51aa7c";

export interface LogLine {
  level: "debug" | "warn";
  message: string;
  data?: Record<string, unknown>;
}

export function contextFor(
  fake: FakeBoat,
  extra: { secret?: string; options?: unknown; deadlineMs?: number; signal?: AbortSignal; log?: LogLine[]; now?: () => number; instanceId?: string } = {}
): ComputeContext {
  const lines = extra.log ?? [];
  return {
    instanceId: extra.instanceId ?? "boat-small",
    options: extra.options ?? {},
    secret: extra.secret ?? KEY,
    signal: extra.signal ?? new AbortController().signal,
    deadline: (extra.now ?? Date.now)() + (extra.deadlineMs ?? 60_000),
    fetch: fake.fetch,
    log: {
      debug: (message, data) => lines.push({ level: "debug", message, data }),
      warn: (message, data) => lines.push({ level: "warn", message, data }),
    },
  };
}

/** An adapter on a fake clock: every wait advances the clock instead of sleeping. */
export function instantProvider(start = Date.parse("2026-07-12T09:00:00Z")) {
  let t = start;
  const waits: number[] = [];
  const provider = createBoatProvider({
    now: () => t,
    sleep: async (ms) => {
      waits.push(ms);
      t += ms;
    },
  });
  return { provider, waits, now: () => t, advance: (ms: number) => (t += ms) };
}
