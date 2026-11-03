import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, Placeholder, ScreenHeader } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot } from "../../root-context.js";
import type { BrainUiRoot } from "../../root.js";
import { useMediaQuery } from "../../hooks/use-media-query.js";
import { pendingApifyFocus } from "../../lib/apify-focus.js";
import { PiAccountsSection } from "./pi-accounts.js";
import { WebSearchSection } from "./web-search-settings.js";
import { ApifySection } from "./apify-section.js";

const PANE_QUERY = "(min-width: 900px)";

/**
 * Existing containers own their requests/flows; this combines their presence.
 * External services › Apify (#3163, R1 A) is inline on desktop and a drill-in
 * on phones, with a Back that returns focus to its row.
 */
export function AccountsTab({ active }: { active: boolean }) {
  const root = useBrainUiRoot();
  const pane = useMediaQuery(PANE_QUERY);
  const [accounts, setAccounts] = useState<{ root: BrainUiRoot; present: boolean | null } | null>(null);
  const [search, setSearch] = useState<{ root: BrainUiRoot; present: boolean | null } | null>(null);
  const [apify, setApify] = useState<{ root: BrainUiRoot; present: boolean | null } | null>(null);
  const [drill, setDrill] = useState<{ root: BrainUiRoot; open: boolean } | null>(() => ({ root, open: !!pendingApifyFocus(root) }));
  const returning = useRef(false);
  const tab = useRef<HTMLDivElement>(null);
  const accountPresence = useCallback((present: boolean | null) => setAccounts({ root, present }), [root]);
  const searchPresence = useCallback((present: boolean | null) => setSearch({ root, present }), [root]);
  const apifyPresence = useCallback((present: boolean | null) => setApify({ root, present }), [root]);
  const a = accounts?.root === root ? accounts.present : null;
  const s = search?.root === root ? search.present : null;
  const p = apify?.root === root ? apify.present : null;
  const drilled = !pane && drill?.root === root && drill.open;
  // A "Why" link opening Accounts on a phone lands in the Apify detail.
  useEffect(() => { if (active && !pane && pendingApifyFocus(root)) setDrill({ root, open: true }); }, [active, pane, root]);
  useLayoutEffect(() => {
    if (!returning.current || drilled) return;
    returning.current = false;
    tab.current?.querySelector<HTMLElement>("[data-apify-drill] [role=\"button\"]")?.focus();
  }, [drilled]);

  if (drilled) return <div ref={tab} className="min-h-0 flex-1 overflow-y-auto" data-apify-detail>
    <div className="flex min-w-0 shrink-0 items-center border-b border-border px-3">
      <Button label="Back to accounts" tone="quiet" size="sm" block={false} reach onClick={() => { returning.current = true; setDrill({ root, open: false }); }} />
      <div className="min-w-0 flex-1"><ScreenHeader variant="nav" title="Apify" subtitle="external services · paid web extraction" back={false} divider={false} /></div>
    </div>
    <div className="px-4 py-4"><ApifySection active={active} layout="detail" /></div>
  </div>;

  // The pi and web-search empty state is about those two; Apify keeps its own section.
  const none = a === false && s === false;
  return <div ref={tab} className="min-h-0 flex-1 overflow-y-auto">
    <ScreenHeader variant="nav" title="Accounts" subtitle="provider connections · web search · external services" back={false} divider={false} />
    <div className="px-4 pb-4">
      <PiAccountsSection active={active} onPresence={accountPresence} />
      <WebSearchSection active={active} onPresence={searchPresence} />
      {p !== false && <section aria-labelledby="external-services-heading" className="my-5 min-w-0 space-y-2">
        <h3 id="external-services-heading" className="text-sm font-semibold">External services</h3>
        {pane ? <ApifySection active={active} layout="inline" onPresence={apifyPresence} />
          : <ApifySection active={active} layout="row" onPresence={apifyPresence} onOpen={() => setDrill({ root, open: true })} />}
      </section>}
      {active && (a === null || s === null) && a !== true && s !== true && p !== true && <Placeholder variant="loading" lines={2} />}
      {active && none && <Placeholder variant="empty" message="No other provider accounts or web-search providers are configured on this server." />}
    </div>
  </div>;
}
