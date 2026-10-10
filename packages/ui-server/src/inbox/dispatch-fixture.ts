/**
 * Test-harness activation of the production dispatcher (#689 ruling,
 * 2026-10-10). Production autonomous dispatch stays disabled: no config key,
 * environment variable or default constructs it. This module is not exported
 * from any package entry point (`.` or `./internal`), so the symbol below is
 * unreachable to consumers; only the repository's fixture host can pass it.
 * Enablement waits for the generated host's glue and the reserved verification.
 */
import type { BackendRegistry } from "../agent/backend.js";
import type { FetchLike } from "../classification/jev-client.js";
import type { InboxDispatchSelection } from "./dispatcher.js";

export const INBOX_DISPATCH_FIXTURE: unique symbol = Symbol("brain-kit inbox dispatch fixture");

export interface InboxDispatchFixture {
  /** Server-selected backend, profile and admission bounds for agent-tier work. */
  select(registry: BackendRegistry): Promise<InboxDispatchSelection | null>;
  /** Keyless classification transport for T1 (a loopback fixture). */
  fetch?: FetchLike;
  classificationKey?: string;
}

export type InboxDispatchFixtureOptions = { [INBOX_DISPATCH_FIXTURE]?: InboxDispatchFixture };
