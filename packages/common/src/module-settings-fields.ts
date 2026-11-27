/**
 * The two module-settings field types core validates and the hosted UI renders
 * (#4716). `@schlessera/brain` and `@schlessera/brain-ui-sdk` both re-export
 * them from their ordinary entries, which carry the compatibility promise; the
 * SDK cannot depend on core, so the one declaration lives here.
 */
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
