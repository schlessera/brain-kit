import { useEffect, useRef, useState } from "react";
import { Button } from "@schlessera/brain-ui-kit";
import type { ApifySettingsRead } from "@schlessera/brain-ui-sdk/protocol";
import { useBrainUiRoot } from "../../root-context.js";
import { openApifySettings } from "../../lib/apify-focus.js";
import { ApifySpendBody } from "../settings/apify-view.js";

/**
 * Apify spend in Activity (#3163, R3 A): today's totals and the runs whose
 * charges are not final, from the same owner read as Settings. Shown only
 * where Apify has something to say; agents and hosts without it see nothing.
 */
export function ApifyActivity({ only }: { only: "unresolved" | "today" }) {
  const root = useBrainUiRoot();
  const [read, setRead] = useState<ApifySettingsRead | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const token = ++generation.current, epoch = root.authLock.epoch(), controller = new AbortController();
    setRead(null);
    root.api.apify({ signal: controller.signal }).then(next => {
      if (token === generation.current && epoch === root.authLock.epoch()) setRead(next);
    }, () => { /* Not an owner, or unavailable: nothing to show here. */ });
    const invalidate = () => { generation.current++; controller.abort(); };
    return invalidate;
  }, [root]);
  if (!read) return null;
  const unresolved = read.spend.unresolved.length;
  if (only === "unresolved" && !unresolved) return null;
  if (only === "today" && read.spend.ledger === "absent" && read.reason === "not_enabled") return null;
  return <section aria-labelledby={`apify-activity-${only}`} className="space-y-2" data-apify-activity={only}>
    <h2 id={`apify-activity-${only}`} className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {only === "unresolved" ? `Apify · ${unresolved} unresolved` : "Apify · today"}
    </h2>
    <ApifySpendBody read={read} />
    <div className="flex flex-wrap gap-2"><Button label="Apify settings" tone="quiet" size="sm" block={false} reach onClick={() => openApifySettings(root, "today")} /></div>
  </section>;
}
