import { DefaultPackageManager, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { BackendRequestError, type AgentBackend } from "@schlessera/brain-ui-sdk/server";

/**
 * One extension resource Pi's loader would load with discovery on (#3658).
 * `missing` marks a configured package that is not installed: the loader would
 * report it as a loading error, which managed collection treats the same way.
 */
export interface PiExtensionFinding {
  /** Resolved file, or the configured package source when `missing`. */
  path: string;
  /** Pi's own resource metadata: `auto` for an extension directory, else the package source. */
  source: string;
  scope: string;
  missing?: true;
}

export type PiExtensionInspection =
  | { ok: true; findings: PiExtensionFinding[] }
  | { ok: false; error: string };

/**
 * What extension discovery would load, read as data (#3658). Resolves the same
 * settings package lists and global/project extension directories the native
 * loader reads, through Pi's own package manager, without importing any of
 * them and without installing a missing package: a missing source is recorded
 * and skipped. No built-in extension factories are supplied, matching managed
 * sessions, which pass none.
 *
 * An inspection failure is reported, never treated as "no extensions": a
 * caller that must fail closed refuses on it.
 */
export async function inspectPiExtensions(brainPath: string, agentDir: string = getAgentDir()): Promise<PiExtensionInspection> {
  try {
    const settingsManager = SettingsManager.create(brainPath, agentDir);
    const missing: PiExtensionFinding[] = [];
    const resolved = await new DefaultPackageManager({ cwd: brainPath, agentDir, settingsManager })
      .resolve(async (source) => {
        missing.push({ path: source, source, scope: "configured", missing: true });
        return "skip";
      });
    const findings = resolved.extensions
      .filter((resource) => resource.enabled)
      .map((resource) => ({ path: resource.path, source: resource.metadata.source, scope: resource.metadata.scope }));
    return { ok: true, findings: [...findings, ...missing] };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** One operator-facing line naming every finding, for logs and refusals. */
export function describePiExtensionFindings(inspection: PiExtensionInspection): string {
  if (!inspection.ok) return `extension inspection failed (${inspection.error})`;
  return inspection.findings
    .map((finding) => `${finding.path} (${finding.missing ? "configured, not installed" : `${finding.scope}, ${finding.source}`})`)
    .join(", ");
}

/**
 * Whether a backend option set loads Pi extensions (#3658): only an explicit
 * `true`. Every path that decides it (backend, worker entry, execution proof)
 * reads this one rule.
 */
export function discoversPiExtensions(options: { loadExtensions?: boolean }): boolean {
  return options.loadExtensions === true;
}

/** The hosted setting that turns extension discovery back on (#3658). */
export const PI_EXTENSIONS_ENV = "BRAIN_UI_PI_EXTENSIONS";

/**
 * What makes Pi's first managed turn fail in this configuration, if anything
 * (#3658). With discovery on, any extension or loading error does. In the
 * curated default only a configured package that is not installed does:
 * managed workers require prepared packages even when they load no extension.
 * An inspection failure is never "nothing found".
 */
export function blockingPiConfiguration(inspection: PiExtensionInspection, discover: boolean): PiExtensionInspection | undefined {
  if (!inspection.ok) return inspection;
  const findings = discover ? inspection.findings : inspection.findings.filter(finding => finding.missing);
  return findings.length > 0 ? { ok: true, findings } : undefined;
}

/** Why Pi cannot run managed turns in this configuration, with the way out. */
export function unsupportedConfigurationMessage(blocking: PiExtensionInspection, discover: boolean): string {
  if (!discover && blocking.ok) {
    return `Pi cannot run managed turns: configured Pi packages are not installed: ${describePiExtensionFindings(blocking)}. ` +
      "Install them on the host or remove them from Pi's settings.";
  }
  return `Pi cannot run managed turns with extension discovery on: ${describePiExtensionFindings(blocking)}. ` +
    "Managed input-safety collection does not support loaded Pi extensions. " +
    `Set ${PI_EXTENSIONS_ENV}=curated (the default) to use the curated tools; installed extensions are kept.`;
}

/**
 * The hosted pre-admission gate (#3658). Before each roster read and each
 * non-restricted turn, inspect Pi's extension configuration as data. When it
 * would fail the turn (`blockingPiConfiguration`), the backend runs no
 * profile: `listProfiles` is empty, every configured profile is reported
 * unavailable as `unsupported-configuration`, and a turn is refused with a
 * `BackendRequestError` before a worker starts, so the input-safety
 * collector's failure path never engages and other backends keep running.
 * The worker's own load-time refusal stays the backstop for configuration
 * that changes after this check.
 */
export function gateUnsupportedConfiguration(
  backend: AgentBackend,
  brainPath: string,
  discover: boolean,
  inspect: () => Promise<PiExtensionInspection> = () => inspectPiExtensions(brainPath),
): AgentBackend {
  const blocked = async () => blockingPiConfiguration(await inspect(), discover);
  return {
    ...backend,
    async listProfiles() {
      return (await blocked()) ? [] : backend.listProfiles();
    },
    async listUnavailableProfiles() {
      if (!(await blocked())) return (await backend.listUnavailableProfiles?.()) ?? [];
      return (await backend.listProfiles()).map(profile => ({ id: profile.id, label: profile.label, reason: "unsupported-configuration" as const }));
    },
    async startTurn(req) {
      // Restricted autonomous turns load neither extensions nor packages.
      if (req.autonomous?.containment !== "restricted") {
        const found = await blocked();
        if (found) throw new BackendRequestError(unsupportedConfigurationMessage(found, discover));
      }
      return backend.startTurn(req);
    },
  };
}
