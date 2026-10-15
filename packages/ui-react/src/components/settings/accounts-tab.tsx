import { useCallback, useState } from "react";
import { Placeholder, ScreenHeader } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot } from "../../root-context.js";
import type { BrainUiRoot } from "../../root.js";
import { PiAccountsSection } from "./pi-accounts.js";
import { WebSearchSection } from "./web-search-settings.js";

/** Existing containers own their requests/flows; this combines their presence. */
export function AccountsTab({ active }: { active: boolean }) {
  const root = useBrainUiRoot();
  const [accounts, setAccounts] = useState<{ root: BrainUiRoot; present: boolean | null } | null>(null);
  const [search, setSearch] = useState<{ root: BrainUiRoot; present: boolean | null } | null>(null);
  const accountPresence = useCallback((present: boolean | null) => setAccounts({ root, present }), [root]);
  const searchPresence = useCallback((present: boolean | null) => setSearch({ root, present }), [root]);
  const a = accounts?.root === root ? accounts.present : null;
  const s = search?.root === root ? search.present : null;
  return <div className="min-h-0 flex-1 overflow-y-auto">
    <ScreenHeader variant="nav" title="Accounts" subtitle="provider connections · web search" back={false} divider={false} />
    <div className="px-4 pb-4">
      <PiAccountsSection active={active} onPresence={accountPresence} />
      <WebSearchSection active={active} onPresence={searchPresence} />
      {active && (a === null || s === null) && a !== true && s !== true && <Placeholder variant="loading" lines={2} />}
      {active && a === false && s === false && <Placeholder variant="empty" message="No other provider accounts or web-search providers are configured on this server." />}
    </div>
  </div>;
}
