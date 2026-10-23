/** Hosted turn admission and reconciliation; no repository code runs here. */
import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { KeyedLock } from "@schlessera/brain-ui-sdk/server";
import { isManagedWorkerStartupView, prepareNativeWorkerStartupView, createNativeBrainManagerClient, prepareWorkerSandbox, workerProfile, type WorkerSandbox, type WorkerStartupView } from "@schlessera/brain-ui-sdk/internal";
import type { HostExecution } from "./host-execution.js";
import { assertReconciled, type Reconciliation } from "./governed-manifest.js";
import { protectedPaths } from "@schlessera/brain-common/internal/protected-paths";
import { createGovernancePolicyReader, exposedAnything, exposureConflicts, ProviderPolicyRefusedError, ProviderRecipientRefusedError, providerDeniedFolders, providerFolderRoots, providerMaskedFolders, providerTypeSelectors, rememberProviderTypeFolders, retainedFolderRoots, translateProviderTypes, unsupportedProviderSelectors, type ProviderExposure, type TurnGovernancePolicy } from "./governance-policy.js";
import type { ProviderExposures } from "./provider-exposure.js";
import { providerRecipient } from "./provider-recipients.js";
import { buildPrivateIndex, createPrivateIndexDirectory, removePrivateIndexDirectory } from "./private-index.js";
import { readProviderTaxonomy, strayTypedDocuments } from "./provider-types.js";
import { providerHardlinks } from "./provider-hardlinks.js";
import { ensureIndexDirectory } from "./index-directory.js";
import { INDEX_DIR } from "@schlessera/brain-common/internal/index-location";

export interface GovernedTurnHold {
  readonly sandbox: WorkerSandbox;
  readonly policy: TurnGovernancePolicy;
  readonly startupView?: WorkerStartupView;
  /**
   * The configured native manager acquired this turn's startup view with its
   * stage operations. Only such a turn runs on the turn egress proxy (#1665).
   */
  readonly managedStorage: boolean;
  /** Call only once every worker has exited. Quarantine precedes gate release. */
  end(): Promise<Reconciliation | null>;
}
/** Who a turn's inference reaches and which conversation it continues (#2695). */
export interface GovernedTurnRoute {
  /**
   * The exact origin the turn's host inference relay will forward to, from
   * its backend. It names the recipient only on managed native storage, where
   * the relay runs, and the turn's relay then refuses any other origin.
   */
  readonly inferenceOrigin?: string;
  /** The session this turn resumes; absent for a new conversation. */
  readonly sessionId?: string;
  /** Sessions whose provider history this new conversation continues: a handoff's source. */
  readonly inherit?: readonly string[];
}
export interface GovernedTurns {
  begin(turnId: string, signal: AbortSignal, origin?: "interactive" | "voice", preference?: "governed" | "strict", route?: GovernedTurnRoute): Promise<GovernedTurnHold>;
  /** A new conversation was named: what its first turn was shown belongs to it (#2695). */
  bindSession(turnId: string, sessionId: string): void;
  /** What earlier turns of these sessions showed their recipients (#2695). */
  exposures(sessionIds: readonly string[]): ProviderExposure[];
  /** Display facts use the same process-local last-valid reader as admission. */
  facts(origin?: "interactive" | "voice"): { policyProfile: "governed" | "strict"; policy: TurnGovernancePolicy };
  /** Deferred maintenance, serialized with application/CLI mutations. */
  refresh(lock: KeyedLock): void;
  /** Stop new deferred refreshes and drain the current worker before state closes. */
  close(): Promise<void>;
}

export function createGovernedTurns(options: {
  nativeManager: ReturnType<typeof createNativeBrainManagerClient>;
  brainPath: string; execution: HostExecution; profile: "governed" | "strict";
  maskPaths: readonly string[]; index: (lock: KeyedLock) => Promise<unknown>;
  report: (message: string) => void;
  recordPolicy?: (turnId: string, origin: "interactive" | "voice", profile: "governed" | "strict", policy: TurnGovernancePolicy) => void;
  /** The CLI argv that reads a restricted turn's taxonomy and builds its private index; default: the brain's packaged CLI. */
  privateIndexCommand?: readonly string[];
  /**
   * Where each conversation's shown provider folders are recorded (#2695).
   * Without it no recipient is proven, so every provider folder stays masked.
   */
  exposures?: ProviderExposures;
  /** Operator-named gateway origins (`BRAIN_UI_PROVIDER_RECIPIENT_ORIGINS`). */
  recipientOrigins?: ReadonlyMap<string, string>;
}): GovernedTurns {
  const policyReader = createGovernancePolicyReader(options.brainPath);
  let current: Promise<unknown> | undefined;
  let again = false;
  let closing = false;
  const refresh = (lock: KeyedLock): void => {
    if (closing) return;
    if (current) { again = true; return; }
    again = false;
    current = options.index(lock).catch(error => options.report(`governed index refresh failed: ${String(error)}`))
      .finally(() => { current = undefined; if (again) refresh(lock); });
  };
  return {
    refresh,
    facts(origin = "interactive") {
      const policy = policyReader.load();
      return { policyProfile: options.profile === "strict" ? "strict" : policy.policy.profiles[origin], policy };
    },
    async close() { closing = true; again = false; await current; },
    bindSession(turnId, sessionId) { options.exposures?.bind(turnId, sessionId); },
    exposures(sessionIds) { return options.exposures?.forSessions(sessionIds) ?? []; },
    async begin(turnId, signal, origin = "interactive", preference, route) {
      const gate = options.execution.gate();
      const manifests = options.execution.manifests();
      if (!gate || !manifests) throw new Error("Hosted turns require the writer gate and durable manifests");
      const hold = await gate.acquire("shared", `turn:${turnId}`, { signal, turn: true });
      let startupView: WorkerStartupView | undefined, privateIndex: string | undefined;
      const discardPrivateIndex = () => { if (privateIndex) { const dir = privateIndex; privateIndex = undefined; removePrivateIndexDirectory(dir); } };
      try {
        startupView = await prepareNativeWorkerStartupView(options.brainPath, options.nativeManager, signal);
        signal.throwIfAborted();
        const availability = await options.execution.boundary.prepare(signal, startupView);
        const policy = policyReader.load();
        // A provider rule masks its folders from every turn whose recipient it
        // does not allow (#1668). Only the exact origin of the host inference
        // relay proves a recipient (#2695), and only on managed native storage,
        // where that relay runs; any other turn is denied every folder. A masked
        // turn indexes into its own directory from the masked view. A selector
        // that does not map exactly onto folders refuses admission (#2694).
        const recipient = options.exposures && route?.inferenceOrigin && isManagedWorkerStartupView(startupView)
          ? providerRecipient(route.inferenceOrigin, options.recipientOrigins) : undefined;
        const refused = unsupportedProviderSelectors(policy.policy);
        const types = providerTypeSelectors(policy.policy);
        const translate = async (view: WorkerStartupView) => {
          // The taxonomy worker sees only the literal folders masked, so it
          // writes into a throwaway directory, never the turn's private index.
          const scratch = createPrivateIndexDirectory();
          let read: Awaited<ReturnType<typeof readProviderTaxonomy>>;
          try {
            read = await readProviderTaxonomy({ brainPath: options.brainPath, startupView: view, folders: providerFolderRoots(policy.policy), index: scratch,
              maskPaths: options.maskPaths, signal, ...(options.privateIndexCommand ? { command: options.privateIndexCommand } : {}) });
          } finally { removePrivateIndexDirectory(scratch); }
          signal.throwIfAborted();
          if (!read.ok) return { folders: {}, refused: types.map(type => `type ${type} (the brain's taxonomy could not be read: ${read.detail})`) };
          const translated = translateProviderTypes(types, read.taxonomy);
          // A document declares its type in frontmatter, so the folders hold
          // the type only if no document of it lies outside them.
          const strays = strayTypedDocuments(view.root, Object.keys(translated.folders), providerMaskedFolders(policy.policy, translated.folders), options.brainPath);
          const listed = (paths: string[]) => `${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ` and ${paths.length - 3} more` : ""}`;
          const unverified = strays.filter(stray => stray.type === undefined).map(stray => stray.path);
          for (const [type, folders] of Object.entries(translated.folders)) {
            const paths = strays.filter(stray => stray.type === type).map(stray => stray.path);
            if (paths.length) translated.refused.push(`type ${type} (${listed(paths)} ${paths.length === 1 ? "declares" : "declare"} it outside ${folders.join(", ")})`);
            if (unverified.length) translated.refused.push(`type ${type} (${listed(unverified)} ${unverified.length === 1 ? "links" : "link"} to a folder outside the brain, which cannot be checked)`);
          }
          return translated;
        };
        let typeFolders: Record<string, string[]> = {};
        if (types.length && !refused.length) {
          const translated = await translate(startupView);
          refused.push(...translated.refused);
          typeFolders = translated.folders;
        }
        if (refused.length) throw new ProviderPolicyRefusedError(refused);
        const typeFolderList = [...new Set(Object.values(typeFolders).flat())].sort();
        if (types.length) rememberProviderTypeFolders(options.brainPath, policy.hash, typeFolderList);
        const providerFolders = providerMaskedFolders(policy.policy, typeFolders);
        const maskedFolders = providerDeniedFolders(policy.policy, typeFolders, recipient);
        // A conversation's provider history keeps what its earlier turns, or a
        // handoff's source, were shown; this turn's recipient would receive it.
        const continued = [...(route?.sessionId ? [route.sessionId] : []), ...(route?.inherit ?? [])];
        const inherited = route?.inherit?.length ? options.exposures?.forSessions(route.inherit) ?? [] : [];
        const conflicts = exposureConflicts(continued.length ? options.exposures?.forSessions(continued) ?? [] : [], maskedFolders);
        if (conflicts.length) throw new ProviderRecipientRefusedError(conflicts, recipient);
        const folderPaths = hold.retainFolders?.(retainedFolderRoots(policy.policy, typeFolderList))
          ?? [...new Set([...(hold.folderPaths ?? []), ...retainedFolderRoots(policy.policy, typeFolderList)])];
        // Retention needs the directory to exist; the host creates the index
        // directory (never a provider folder) before the layout is resolved.
        // An alias or file under the name stays for the resolver to refuse.
        if (folderPaths.includes(INDEX_DIR)) { try { ensureIndexDirectory(options.brainPath); } catch { /* resolver refuses */ } }
        const requested = options.profile === "strict" || (origin === "interactive" && preference === "strict") ? "strict" : policy.policy.profiles[origin];
        const selected = requested === "governed" && !availability.available ? "strict" : requested;
        const resolveSandbox = () => prepareWorkerSandbox(options.brainPath, { profile: selected,
          protectedPaths: protectedPaths(policy.policy), folderPaths,
          maskPaths: options.maskPaths, maintenance: { ...options.execution.boundary.maintenance, startupView } });
        let resolved = resolveSandbox();
        const missingWritableRoot = () => resolved.areas.find(area => area.mount.writable
          && !lstatSync(join(startupView!.root, area.rel), { throwIfNoEntry: false })?.isDirectory());
        // Host setup may create scratch after the initial admission checkpoint.
        // Refresh only those first-turn sealed consumers, then validate against
        // the refreshed complete view. Two fixed area roots, no inventory walk.
        if (workerProfile(resolved) !== "governed" && missingWritableRoot()) {
          await startupView.cleanup(); startupView = undefined;
          startupView = await prepareNativeWorkerStartupView(options.brainPath, options.nativeManager, signal);
          signal.throwIfAborted(); resolved = resolveSandbox();
          const missing = missingWritableRoot();
          if (missing) throw new Error(`The immutable worker checkpoint does not include writable ${missing.rel} after host setup; retry admission once concurrent setup has settled.`);
          // The turn runs on this newer checkpoint, so its types are judged
          // again there; retention was planned for the first translation.
          if (types.length) {
            const again = await translate(startupView);
            if (again.refused.length) throw new ProviderPolicyRefusedError(again.refused);
            if (JSON.stringify(providerMaskedFolders(policy.policy, again.folders)) !== JSON.stringify(providerMaskedFolders(policy.policy, typeFolders)))
              throw new Error("The brain's document types changed during turn admission; retry once concurrent changes have settled.");
          }
        }
        if (workerProfile(resolved) === "governed" && folderPaths.length) {
          if (!hold.assertPeerFolderPlans) throw new Error("Provider folder admission cannot check active peer plans with this writer gate; retry using the qualified gate");
          hold.assertPeerFolderPlans(folderPaths);
        }
        const commandPolicy = Object.freeze({ hash: policy.hash,
          outwardAllow: Object.freeze(policy.policy.outward.allow.map((rule, index) => Object.freeze({ ...rule, remotes: Object.freeze([...rule.remotes]), index: policy.outwardRuleIndices[index]! }))),
          deny: Object.freeze(policy.policy.commands.deny.map((rule, index) => Object.freeze({ ...rule, index: policy.commandRuleIndices.deny[index]! }))),
          confirm: Object.freeze(policy.policy.commands.confirm.map((rule, index) => Object.freeze({ ...rule, index: policy.commandRuleIndices.confirm[index]! }))),
        });
        if (maskedFolders.length) {
          // A mask hides names, not inodes (#2700). The private index below is
          // built from the final checkpoint; a governed worker also sees the
          // live brain, which may differ from it.
          const roots = [startupView!.root, ...(workerProfile(resolved) === "governed" ? [options.brainPath] : [])];
          const hardlinks = [...new Map(roots.flatMap(root => providerHardlinks(root, maskedFolders)).map(link => [link.path, link])).values()];
          if (hardlinks.length) throw ProviderPolicyRefusedError.hardlinks(hardlinks);
          privateIndex = createPrivateIndexDirectory();
          const built = await buildPrivateIndex({ brainPath: options.brainPath, startupView: startupView!, folders: maskedFolders, index: privateIndex,
            maskPaths: options.maskPaths, signal, ...(options.privateIndexCommand ? { command: options.privateIndexCommand } : {}) });
          if (!built.ok) options.report(`turn ${turnId} starts with an incomplete private search index: ${built.detail}`);
        }
        // A turn allowed every provider folder keeps empty masks, so whatever
        // every provider-rule turn hides regardless of recipient still applies.
        const providerMasks = privateIndex ? Object.freeze({ folders: Object.freeze(maskedFolders), index: privateIndex })
          : providerFolders.length ? Object.freeze({ folders: Object.freeze([] as string[]) }) : undefined;
        const inferenceRecipient = recipient !== undefined && providerFolders.length ? Object.freeze({ name: recipient, origin: route!.inferenceOrigin! }) : undefined;
        const sandbox = { ...resolved, commandPolicy, scopePolicy: policy.policy.scope,
          ...(providerMasks ? { providerMasks } : {}), ...(inferenceRecipient ? { inferenceRecipient } : {}),
          ...(!availability.available && requested === "governed" ? { fallbackReason: availability.detail } : {}) };
        const governed = workerProfile(sandbox) === "governed";
        options.recordPolicy?.(turnId, origin, governed ? "governed" : "strict", policy);
        if (policy.errors.length) options.report(`Governance policy invalid; using ${policy.source}: ${policy.errors.join("; ")}`);
        for (const warning of policy.warnings) options.report(`Governance policy warning: ${warning}`);
        const managedStorage = isManagedWorkerStartupView(startupView);
        if (inferenceRecipient && !managedStorage) throw new Error("The turn's startup view is no longer on managed storage; its inference recipient cannot be proven. Retry admission.");
        if (governed) { await startupView.cleanup(); startupView = undefined; }
        signal.throwIfAborted();
        // Recorded before the turn can read anything; a new conversation's rows bind when it is named.
        const shown: ProviderExposure | undefined = inferenceRecipient ? { recipient: inferenceRecipient.name, visible: providerFolders, hidden: maskedFolders } : undefined;
        for (const exposure of [...inherited, ...(shown && exposedAnything(shown) ? [shown] : [])]) options.exposures!.record(turnId, route?.sessionId ?? null, exposure);
        if (governed) manifests.begin(turnId, sandbox.protection!.paths.map(path => path.rel));
        let ended = false;
        return { sandbox, policy, managedStorage, ...(startupView ? { startupView } : {}), async end() {
          if (ended) return null;
          ended = true;
          try {
            const result = governed ? manifests.end(turnId) : null;
            if (result) assertReconciled([result]);
            return result;
          } finally { try { await startupView?.cleanup(); } finally { try { discardPrivateIndex(); } finally { hold.release(); } } }
        } };
      } catch (error) { try { await startupView?.cleanup(); } finally { try { discardPrivateIndex(); } finally { hold.release(); } } throw error; }
    },
  };
}
