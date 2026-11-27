import type { ModuleSettingsField, ModuleSettingsOption } from "@schlessera/brain-common/internal/module-settings-fields";

export type { ModuleSettingsField, ModuleSettingsOption };

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
