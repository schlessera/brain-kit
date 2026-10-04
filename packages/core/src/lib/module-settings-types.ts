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

export interface ModuleSettingsMigrationPlan {
  values: Record<string, unknown>;
  changes: Array<{ path: string; before: string; after: string }>;
  details: Record<string, unknown>;
}

export interface ModuleSettings<C = unknown> {
  fields: ModuleSettingsField[];
  actions?: Array<{ id: string; label: string; help: string; command: string[]; confirm: string }>;
  notes?(config: C): Array<{ key: string; text: string }>;
  /** Pure preview; core validates and commits the complete transaction. */
  migration?: {
    label: string;
    help?: string;
    target?: string;
    plan(root: string, config: C): ModuleSettingsMigrationPlan;
  };
}
