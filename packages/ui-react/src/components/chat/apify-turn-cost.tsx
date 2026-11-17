import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Callout } from "@schlessera/brain-ui-kit";
import type { ApifySettingsRead, TurnBudgetReceipt } from "@schlessera/brain-ui-sdk/protocol";
import { useBrainUiRoot } from "../../root-context.js";
import { openApifySettings } from "../../lib/apify-focus.js";
import { COVERAGE_NOTE, receiptApify, runLine, scopeSummary, usd } from "../../lib/apify.js";

/**
 * A turn's Apify share, beside its inference (#3163, R3 A). Model inference
 * and Apify stay separate groups, never one exact sum. The receipt's
 * `apifyUsd` (#3307) is admitted liability, an upper bound until the run
 * settles; an unread ledger is unknown, not zero.
 *
 * The owner's live read adds this turn's runs. While any of them is not
 * settled, a notice stays above the turn: a local Stop never proves the
 * remote run stopped, so possible further charges stay visible with Check
 * again and Details until the host settles them.
 */
export function useApifyTurn(receipt: TurnBudgetReceipt | undefined, sessionId: string | null | undefined, turnId: string | undefined) {
  const root = useBrainUiRoot();
  const share = receiptApify(receipt);
  const relevant = share.state === "unknown" || (share.state === "known" && share.apifyUsd > 0);
  const [read, setRead] = useState<ApifySettingsRead | null>(null);
  const [checking, setChecking] = useState(false);
  const generation = useRef(0);
  const load = useCallback(async (refresh = false) => {
    if (!relevant || !sessionId || !turnId) return;
    const token = ++generation.current, epoch = root.authLock.epoch();
    setChecking(refresh);
    try {
      const next = await root.api.apify({ refresh, session: sessionId, turn: turnId });
      if (token === generation.current && epoch === root.authLock.epoch()) setRead(next);
    } catch { /* Not an owner, or unavailable: the receipt's own facts still show. */ }
    finally { if (token === generation.current) setChecking(false); }
  }, [relevant, root, sessionId, turnId]);
  useEffect(() => { setRead(null); void load(); const invalidate = () => { generation.current++; }; return invalidate; }, [load]);
  return { share, read, checking, check: () => void load(true), root };
}

/** Above the turn: unresolved remote work after a local stop or an unknown start. */
export function ApifyTurnNotice({ state }: { state: ReturnType<typeof useApifyTurn> }) {
  const runs = state.read?.spend.unresolved ?? [];
  if (!runs.length) return null;
  const bound = runs.reduce((sum, run) => sum + run.liability_usd, 0);
  const unconfirmed = runs.some(run => run.abort !== null || run.state === "aborting");
  const unknown = runs.some(run => run.remote_outcome_unknown);
  const text = unconfirmed ? `Stopped here. Apify hasn't confirmed the run stopped. ${usd(bound)} is held as an estimate; final charges may differ.`
    : unknown ? `Apify hasn't confirmed whether a run started. ${usd(bound)} stays reserved as an estimate until it reports.`
    : `${runs.length} Apify ${runs.length === 1 ? "run isn't" : "runs aren't"} settled yet. ${usd(bound)} is held as an estimate; final charges may differ.`;
  return <div className="mt-2 min-w-0 space-y-2" data-apify-turn-notice role="status">
    <Callout tone="gold" text={text} />
    <div className="flex flex-wrap gap-2">
      <Button label={state.checking ? "Checking…" : "Check again"} tone="quiet" size="sm" block={false} reach disabled={state.checking} onClick={state.check} />
      <Button label="Details" ariaLabel="Apify spend details" tone="quiet" size="sm" block={false} reach onClick={() => openApifySettings(state.root, "today")} />
    </div>
  </div>;
}

/** Inside Turn facts: the Apify group, separate from inference. */
export function ApifyTurnCost({ state }: { state: ReturnType<typeof useApifyTurn> }) {
  const { share, read } = state;
  if (share.state === "none") return null;
  return <section className="grid min-w-0 gap-2" data-apify-turn-cost={share.state}>
    <h3 className="font-medium">Apify</h3>
    {share.state === "unknown"
      ? <p>Apify spend: unknown. The Apify ledger couldn't be read for this receipt, so its spend isn't counted here, and it isn't $0.</p>
      : <p>Estimated Apify liability this turn: {usd(share.apifyUsd)}; final charges may differ. It counts against the budgets above as dollars, never as tokens. Model inference: {share.inferenceUsd === null ? "price unknown" : `${usd(share.inferenceUsd)} observed lower bound`}.</p>}
    {read?.spend.turn && <p>Now: {scopeSummary(read.spend.turn)}.</p>}
    {read?.spend.ledger === "unavailable" && <p>Now: unknown. The Apify ledger couldn't be read.</p>}
    {!!read?.spend.unresolved.length && <ul className="grid gap-1">{read.spend.unresolved.map(run => {
      const line = runLine(run);
      return <li key={run.key} className="break-words"><span className="font-mono">{run.actor_id}</span> build {run.build_number}: {line.value}. {line.note}</li>;
    })}</ul>}
    <p className="text-muted-foreground">{COVERAGE_NOTE}</p>
  </section>;
}
