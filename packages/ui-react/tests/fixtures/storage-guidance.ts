import type {
  StorageGuidanceResponse,
  StorageHistoryResponse,
  StorageHistoryObservation,
} from "@schlessera/brain-ui-sdk/protocol";
import { storageViewFixture } from "./storage-view.js";
export const guidanceTime = Date.UTC(2026, 6, 12, 9, 41),
  day = 86_400_000;
/** Odysseus-only evidence, including a retained warning with no usable forecast. */
export function storageGuidanceFixture() {
  const inventory = storageViewFixture(),
    at = guidanceTime,
    identity = "a".repeat(32),
    scope = "b".repeat(32);
  const scenario = (days: number) => ({
    state: "finite" as const,
    reason: null,
    start: at - 15 * day,
    end: at,
    samples: 16,
    depletionPerDay: 1_000_000,
    days,
  });
  const guidance: StorageGuidanceResponse = {
    version: 1,
    state: "current",
    severity: "critical",
    paused: null,
    pending: false,
    observedAt: at,
    scopeLimit: false,
    untracked: [],
    capacities: [
      {
        identity,
        rootScope: scope,
        severity: "critical",
        at,
        state: "current",
        scopeChanged: false,
        recoveryAt: at - 60_000,
        episode: "ithaca-episode",
        causes: {
          capacity: true,
          forecast: true,
          refusals: [
            {
              target: "c".repeat(32),
              resource: "bytes",
              at: at - 120_000,
              successAt: at - 60_000,
            },
          ],
        },
        stores: [{ label: "App journal", owner: "app" }],
        evidence: {
          identity,
          rootScope: scope,
          at,
          total: 1_000_000_000,
          available: 40_000_000,
          fresh: true,
          short: { ...scenario(4), start: at - 2 * day, samples: 9 },
          long: scenario(80),
          appAllocated: {
            start: at - 2 * day,
            end: at,
            samples: 9,
            bytesPerDay: 0,
          },
          appLogical: {
            start: at - 2 * day,
            end: at,
            samples: 9,
            bytesPerDay: 20_000,
          },
          availableChange: {
            start: at - 2 * day,
            end: at,
            samples: 9,
            bytesPerDay: -10_000_000,
          },
        },
      },
    ],
    notifications: {
      permission: "browser-managed",
      quietHours: { start: 22, end: 8, unknownZone: "defer" },
      subscriptionsTruncated: false,
      receiptsTruncated: false,
      subscriptions: [
        { zoneKnown: false, quiet: null },
        { zoneKnown: true, quiet: true },
      ],
      receipts: [
        {
          episode: "ithaca-accepted",
          state: "accepted",
          attempts: 1,
          nextAt: null,
        },
        {
          episode: "ithaca-unknown",
          state: "unknown",
          attempts: 1,
          nextAt: null,
        },
      ],
    },
  };
  const observation = (
    tier: StorageHistoryObservation["tier"],
    offset: number,
    gap = false
  ): StorageHistoryObservation => ({
    tier,
    at: at - offset,
    startedAt: at - offset - 1000,
    gap,
    source: "scheduled",
    collector: "0.44.0",
    scope,
    basis: "storage-v1",
    coverage: "partial",
    reason: "partial",
    capacities: [
      {
        identity,
        rootScope: scope,
        coverage: "partial",
        total: 1_000_000_000,
        used: 900_000_000,
        free: 100_000_000,
        available: 40_000_000,
        owners: {
          brain: { logical: 5_100_000, allocated: 5_103_616 },
          app: { logical: 100_000, allocated: null },
          operator: { logical: null, allocated: null },
        },
        union: { logical: null, allocated: null },
      },
    ],
  });
  const history: StorageHistoryResponse = {
    version: 1,
    state: "available",
    paused: null,
    pending: false,
    lastObservedAt: at,
    payloadBytes: 12345,
    limits: {
      sixHour: 64,
      daily: 90,
      weekly: 32,
      capacities: 4,
      payloadBytes: 262144,
    },
    observations: [
      observation("six-hour", day),
      observation("six-hour", 0, true),
      observation("daily", 3 * day),
      observation("daily", 0),
      observation("weekly", 14 * day),
      observation("weekly", 0, true),
    ],
  };
  let status = 200,
    hold: Promise<void> | null = null;
  const reads: string[] = [];
  const request = async (url: string, init?: RequestInit) => {
    const path = new URL(url, "http://fixture.invalid").pathname;
    if (!path.endsWith("/guidance") && !path.endsWith("/history"))
      return inventory.request(url, init);
    reads.push(path);
    const body = structuredClone(
        path.endsWith("/guidance") ? guidance : history
      ),
      responseStatus = status,
      wait = hold;
    if (wait) await wait; // Intentionally ignores abort: exercise the consumer's response ownership guard.
    return Response.json(
      responseStatus === 200 ? body : { error: "Synthetic authority response" },
      { status: responseStatus }
    );
  };
  return {
    inventory,
    guidance,
    history,
    request,
    reads,
    setStatus(value: number) {
      status = value;
    },
    hold(value: Promise<void> | null) {
      hold = value;
    },
  };
}
