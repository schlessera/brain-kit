/** Hosted turn admission and reconciliation; no repository code runs here. */
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { KeyedLock } from "@schlessera/brain-ui-sdk/server";
import { isManagedWorkerStartupView, prepareNativeWorkerStartupView, createNativeBrainManagerClient, prepareWorkerSandboxAsync, workerProfile, type WorkerSandbox, type WorkerStartupView } from "@schlessera/brain-ui-sdk/internal";
import type { HostExecution } from "./host-execution.js";
import { assertReconciled, type Reconciliation } from "./governed-manifest.js";
import { protectedPaths } from "@schlessera/brain-common/internal/protected-paths";
import { exposedAnything, exposureConflicts, governancePolicyReaderFor, maskedInBoth, ProviderContinuationRefusedError, ProviderPolicyRefusedError, ProviderRecipientRefusedError, providerDeniedFolders, providerMaskedFolders, providerTypeSelectors, rememberProviderTypeFolders, retainedFolderRoots, uncoveredFolders, unsupportedProviderSelectors, type ProviderExposure, type TurnGovernancePolicy } from "./governance-policy.js";
import type { ProviderExposures } from "./provider-exposure.js";
import { providerRecipient } from "./provider-recipients.js";
import { buildPrivateIndex, createPrivateIndexDirectory, removePrivateIndexDirectory, updatePrivateIndex } from "./private-index.js";
import { createPrivateIndexCache, privateIndexBuildFolders, type PrivateIndexDiffer, type PrivateIndexOutcome } from "./private-index-cache.js";
import { privateIndexArgv } from "./client.js";
import { translateProviderTypesInView } from "./provider-types.js";
import { providerHardlinks } from "./provider-hardlinks.js";
import { ensureIndexDirectory } from "./index-directory.js";
import { INDEX_DIR } from "@schlessera/brain-common/internal/index-location";

export interface GovernedTurnHold {
  readonly sandbox: WorkerSandbox;
  readonly policy: TurnGovernancePolicy;
  /** The folders each selected type was translated to; host tools name the rule from it (#2690). */
  readonly typeFolders?: Readonly<Record<string, readonly string[]>>;
  readonly startupView?: WorkerStartupView;
  /**
   * The configured native manager acquired this turn's startup view with its
   * stage operations. Only such a turn runs on the turn egress proxy (#1665).
   */
  readonly managedStorage: boolean;
  /** How the turn's private index was made: a clean build, or a reused or updated base (#2833). */
  readonly privateIndex?: PrivateIndexOutcome;
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
  /**
   * Whether this session's history may hold a folder the current policy hides
   * from a run with no proven recipient (#2726): the policy masks provider
   * folders, and the session has no born-masked lineage covering them.
   */
  unprovenHistory(sessionId: string): boolean;
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
  /** How long provider folder admission waits for an earlier writer to finish; default `PEER_FOLDER_PLAN_WAIT_MS`. */
  peerFolderPlanWaitMs?: number;
  /** How two startup views are compared for private index reuse; default the native send delta. */
  privateIndexDiffer?: PrivateIndexDiffer;
}): GovernedTurns {
  const policyReader = governancePolicyReaderFor(options.brainPath);
  const canonicalBrain = (() => { try { return realpathSync(options.brainPath); } catch { return options.brainPath; } })();
  const privateIndexes = createPrivateIndexCache({ report: options.report, ...(options.privateIndexDiffer ? { differ: options.privateIndexDiffer } : {}) });
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
    async close() { closing = true; again = false; await current; await privateIndexes.close(); },
    bindSession(turnId, sessionId) { options.exposures?.bind(turnId, sessionId); },
    exposures(sessionIds) { return options.exposures?.forSessions(sessionIds) ?? []; },
    unprovenHistory(sessionId) {
      const policy = policyReader.load();
      if (!policy.policy.providers.length) return false;
      if (unsupportedProviderSelectors(policy.policy).length) return true;
      // A type selector's folders follow the current taxonomy, which this
      // check does not translate; a remembered translation may be stale, so
      // nothing proves them covered.
      if (providerTypeSelectors(policy.policy).length) return true;
      const always = options.exposures?.maskedThroughout(sessionId);
      return !always || uncoveredFolders(providerMaskedFolders(policy.policy), always).length > 0;
    },
    async begin(turnId, signal, origin = "interactive", preference, route) {
      const gate = options.execution.gate();
      const manifests = options.execution.manifests();
      if (!gate || !manifests) throw new Error("Hosted turns require the writer gate and durable manifests");
      const hold = await gate.acquire("shared", `turn:${turnId}`, { signal, turn: true });
      let startupView: WorkerStartupView | undefined, privateIndex: string | undefined, indexOutcome: PrivateIndexOutcome | undefined;
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
        const translate = (view: WorkerStartupView) => translateProviderTypesInView({ brainPath: options.brainPath, policy: policy.policy, view,
          maskPaths: options.maskPaths, signal, ...(options.privateIndexCommand ? { command: options.privateIndexCommand } : {}) });
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
        // A masked turn continues a conversation only if every folder it masks
        // was masked from every earlier turn of it, or of a handoff's source
        // (#2726). Only a conversation born masked has that record; one from
        // before the policy, or without a record, refuses before its history
        // is copied anywhere. A matching policy is no proof.
        const lineages = continued.map(id => options.exposures?.maskedThroughout(id));
        if (maskedFolders.length) for (const always of lineages) {
          const uncovered = uncoveredFolders(maskedFolders, always ?? []);
          if (uncovered.length) throw new ProviderContinuationRefusedError(uncovered, always ? "shown" : "unrecorded", !route?.sessionId);
        }
        // Born masked, or continuing a lineage: this turn's own masked set
        // narrows it, on an allowed route too. A handoff starts its own from
        // what its source kept masked.
        const lineage = !continued.length ? (maskedFolders.length ? maskedFolders : undefined)
          : lineages.every(always => always !== undefined) ? lineages.reduce<string[]>((kept, always) => maskedInBoth(kept, always!), maskedFolders) : undefined;
        const folderPaths = hold.retainFolders?.(retainedFolderRoots(policy.policy, typeFolderList))
          ?? [...new Set([...(hold.folderPaths ?? []), ...retainedFolderRoots(policy.policy, typeFolderList)])];
        // Retention needs the directory to exist; the host creates the index
        // directory (never a provider folder) before the layout is resolved.
        // An alias or file under the name stays for the resolver to refuse.
        if (folderPaths.includes(INDEX_DIR)) { try { ensureIndexDirectory(options.brainPath); } catch { /* resolver refuses */ } }
        const requested = options.profile === "strict" || (origin === "interactive" && preference === "strict") ? "strict" : policy.policy.profiles[origin];
        const selected = requested === "governed" && !availability.available ? "strict" : requested;
        const resolveSandbox = () => prepareWorkerSandboxAsync(options.brainPath, { profile: selected,
          protectedPaths: protectedPaths(policy.policy), folderPaths,
          maskPaths: options.maskPaths, maintenance: { ...options.execution.boundary.maintenance, startupView } });
        let resolved = await resolveSandbox();
        const missingWritableRoot = () => resolved.areas.find(area => area.mount.writable
          && !lstatSync(join(startupView!.root, area.rel), { throwIfNoEntry: false })?.isDirectory());
        // Host setup may create scratch after the initial admission checkpoint.
        // Refresh only those first-turn sealed consumers, then validate against
        // the refreshed complete view. Two fixed area roots, no inventory walk.
        if (workerProfile(resolved) !== "governed" && missingWritableRoot()) {
          await startupView.cleanup(); startupView = undefined;
          startupView = await prepareNativeWorkerStartupView(options.brainPath, options.nativeManager, signal);
          signal.throwIfAborted(); resolved = await resolveSandbox();
          const missing = missingWritableRoot();
          if (missing) throw new Error(`The immutable worker checkpoint does not include writable ${missing.rel} after host setup; retry admission once concurrent setup has settled.`);
          // The turn runs on this newer checkpoint, so its types are judged
          // again there; retention was planned for the first translation.
          if (types.length) {
            const again = await translate(startupView);
            if (again.refused.length) throw new ProviderPolicyRefusedError(again.refused);
            if (JSON.stringify(providerMaskedFolders(policy.policy, again.folders)) !== JSON.stringify(providerMaskedFolders(policy.policy, typeFolders)))
              throw new Error("The brain's document types changed during turn admission; retry once concurrent changes have settled.");
            // The same folders, but the newer translation names their types (#2690).
            typeFolders = again.folders;
          }
        }
        if (workerProfile(resolved) === "governed" && folderPaths.length) {
          if (!hold.assertPeerFolderPlans) throw new Error("Provider folder admission cannot check active peer plans with this writer gate; retry using the qualified gate");
          // A writer admitted before this turn retained its folders, such as
          // one started with the server before any turn had translated a type
          // selector, finishes rather than refusing the turn (#2832).
          if (hold.waitForPeerFolderPlans) await hold.waitForPeerFolderPlans(folderPaths, { signal, ...(options.peerFolderPlanWaitMs !== undefined ? { timeoutMs: options.peerFolderPlanWaitMs } : {}) });
          else hold.assertPeerFolderPlans(folderPaths);
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
          // Reused only when the base provably indexes to what a clean build
          // of this final view would (#2833); otherwise built from nothing.
          const run = { brainPath: options.brainPath, startupView: startupView!, folders: privateIndexBuildFolders(maskedFolders, startupView!.root), index: privateIndex,
            maskPaths: options.maskPaths, signal, ...(options.privateIndexCommand ? { command: options.privateIndexCommand } : {}) };
          indexOutcome = await privateIndexes.prepare({ startupView: startupView!, index: privateIndex, signal,
            identity: { brain: canonicalBrain, policyHash: policy.hash, folders: maskedFolders, ...(recipient ? { recipient } : {}),
              maskPaths: options.maskPaths, command: privateIndexArgv(options.brainPath, options.privateIndexCommand) },
            build: () => buildPrivateIndex(run), update: () => updatePrivateIndex(run) });
          if (indexOutcome.kind === "partial") options.report(`turn ${turnId} starts with an incomplete private search index: ${indexOutcome.detail}`);
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
        // A turn that fails later in admission still narrows: that only refuses more.
        if (lineage && route?.sessionId) options.exposures?.narrowMasked(turnId, route.sessionId, lineage);
        else if (lineage) options.exposures?.startMasked(turnId, lineage);
        if (governed) manifests.begin(turnId, sandbox.protection!.paths.map(path => path.rel));
        let ended = false;
        return { sandbox, policy, managedStorage, typeFolders, ...(startupView ? { startupView } : {}), ...(indexOutcome ? { privateIndex: indexOutcome } : {}), async end() {
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
