/** Hosted settings use one write channel, including their read/compute/write flows. */
import type { Logger, LogRecord } from "@opentelemetry/api-logs";
import type { Database } from "bun:sqlite";
import { procedureCaller, type SqliteWriter } from "./write-worker.js";
import * as settings from "./settings.js";
import { dismissActivityDigest, generateActivityDigest } from "../activity/digest.js";
import { keepSubscriptionProof, lastSubscriptionTurnAt } from "../agent/subscription.js";

export const url = import.meta.url;
function operations(db: Database, log?: Logger) {
  return {
    setSetting: (key: string, value: unknown) => settings.setSetting(db, key, value),
    setHiddenModelIds: (ids: string[]) => settings.setHiddenModelIds(db, ids),
    setDefaultModelId: (id: string | null) => settings.setDefaultModelId(db, id),
    setCustomOpenRouterModels: (ids: string[]) => settings.setCustomOpenRouterModels(db, ids),
    setBillingOverrides: (value: Parameters<typeof settings.setBillingOverrides>[1]) => settings.setBillingOverrides(db, value),
    setThinkingOverrides: (value: Parameters<typeof settings.setThinkingOverrides>[1]) => settings.setThinkingOverrides(db, value),
    setAutoAllowedTools: (tools: string[]) => settings.setAutoAllowedTools(db, tools),
    addAutoAllowedTool(tool: string) {
      settings.setAutoAllowedTools(db, [...settings.getAutoAllowedTools(db, log), tool]);
    },
    removeAutoAllowedTool(tool: string) {
      const current = settings.getAutoAllowedTools(db, log);
      if (!current.includes(tool)) return null;
      settings.setAutoAllowedTools(db, current.filter(t => t !== tool));
      return settings.getAutoAllowedTools(db, log);
    },
    dismissActivityDigest: (now: number) => dismissActivityDigest(db, now),
    generateActivityDigest: (now: number) => generateActivityDigest(db, now),
    keepSubscriptionProof: (at: number) => keepSubscriptionProof(db, at),
    lastSubscriptionTurnAt: () => lastSubscriptionTurnAt(db),
  };
}
type Procedures = ReturnType<typeof operations>;
export function setup(db: Database) {
  const records: LogRecord[] = [];
  const procedures = operations(db, { emit: record => { records.push(record); }, enabled: () => true });
  return {
    write(name: keyof Procedures, args: unknown[]) {
      records.length = 0;
      const value = Reflect.apply(procedures[name], procedures, args);
      return { value, records: [...records] };
    },
  };
}
export type SettingsWrites = {
  [K in keyof Procedures]: (...args: Parameters<Procedures[K]>) => ReturnType<Procedures[K]> | Promise<ReturnType<Procedures[K]>>;
};
export function createSettingsWrites(db: Database, writer?: SqliteWriter, log?: Logger): SettingsWrites {
  if (!writer) return operations(db, log);
  const call = procedureCaller(db, { url, setup }, undefined, writer);
  const invoke = <K extends keyof Procedures>(name: K, args: Parameters<Procedures[K]>) =>
    call<{ value: ReturnType<Procedures[K]>; records: LogRecord[] }>("write", name, args).then(result => {
      for (const record of result.records) log?.emit(record);
      return result.value;
    });
  return {
    setSetting: (...args) => invoke("setSetting", args),
    setHiddenModelIds: (...args) => invoke("setHiddenModelIds", args),
    setDefaultModelId: (...args) => invoke("setDefaultModelId", args),
    setCustomOpenRouterModels: (...args) => invoke("setCustomOpenRouterModels", args),
    setBillingOverrides: (...args) => invoke("setBillingOverrides", args),
    setThinkingOverrides: (...args) => invoke("setThinkingOverrides", args),
    setAutoAllowedTools: (...args) => invoke("setAutoAllowedTools", args),
    addAutoAllowedTool: (...args) => invoke("addAutoAllowedTool", args),
    removeAutoAllowedTool: (...args) => invoke("removeAutoAllowedTool", args),
    dismissActivityDigest: (...args) => invoke("dismissActivityDigest", args),
    generateActivityDigest: (...args) => invoke("generateActivityDigest", args),
    keepSubscriptionProof: (...args) => invoke("keepSubscriptionProof", args),
    lastSubscriptionTurnAt: () => invoke("lastSubscriptionTurnAt", []),
  };
}
