import type { BrainApi } from "../lib/api-client.js";

/** Concrete dependencies shared by the store factories of one UI root. */
export interface StoreEnvironment {
  api: BrainApi;
  apiBase: () => string;
  request: (url: string, init?: RequestInit) => Promise<Response>;
  storage: () => Storage | null;
  storageKey: (key: string) => string;
}
