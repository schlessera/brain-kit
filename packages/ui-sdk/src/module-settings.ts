/** Data-only instructions for the generic Settings renderer. */
export interface ModuleSettingsOption {
  value: string;
  label: string;
  disabled?: boolean;
  help?: string;
}

export interface ModuleSettingsField {
  key: string;
  kind?: "text" | "number" | "toggle" | "choice" | "multichoice" | "tags" | "weights" | "record" | "list" | "variant";
  label: string;
  help?: string;
  group?: string;
  order?: number;
  unit?: string;
  currency?: string;
  minorUnits?: boolean;
  min?: number;
  max?: number;
  step?: number;
  appliesAt?: "next-run" | "restart";
  readOnly?: { reason: string; whenInherited?: boolean };
  options?: ModuleSettingsOption[];
  fields?: ModuleSettingsField[];
  itemTitle?: string;
  collapsible?: boolean;
  orderMatters?: boolean;
  minItems?: number;
  uniqueBy?: string;
  addLabel?: string;
  variants?: Array<{ key: string; label: string; fields: ModuleSettingsField[] }>;
  optional?: { label: string; presentLabel?: string };
  /** Display only; absent inputs stay absent until edited. */
  default?: unknown;
}

export interface ModuleSettingsSnapshot {
  module: string;
  key: string;
  state: "active" | "dormant";
  canBeDormant: boolean;
  dormancyReason: string | null;
  schema: Record<string, unknown>;
  values: unknown;
  inherited: unknown;
  overrides: Record<string, unknown>;
  provenance: Record<string, "default" | "brain-config" | "saved" | "migrated">;
  inheritedProvenance: Record<string, "default" | "brain-config">;
  notes: Array<{ key: string; text: string }>;
  revision: string;
  ui: {
    fields: ModuleSettingsField[];
    actions: Array<{ id: string; label: string; help: string; command: string[]; confirm: string }>;
    migration: { label: string; help?: string | null; target: string | null } | null;
  };
  changed?: boolean;
  commit?: string | null;
}

export interface ModuleSettingsFailure {
  error: string;
  status: 404 | 409 | 422 | 500;
  errors: Array<{ path: string; message: string }>;
}

export interface ConfiguredModule {
  name: string;
  key: string;
  description: string | null;
  state?: "active" | "dormant" | "unavailable";
  error?: string;
  contextTokens?: number;
  settings?: boolean;
  canBeDormant?: boolean;
  dormancyReason?: string | null;
}

export interface ModuleSettingsMigrationPreview {
  source: string;
  summary?: string;
  revision: string;
  values: Record<string, unknown>;
  original?: unknown;
  moved?: unknown;
  retained?: unknown;
  parserEquivalent?: boolean;
  alreadyMoved?: boolean;
  warnings?: string[];
  paths: string[];
}
