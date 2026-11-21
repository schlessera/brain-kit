/** One concrete proxy operation's lifecycle; transport callbacks never advance state themselves. */
export type EgressOperationState = 'pending' | 'admitted' | 'dispatched' | 'finished' | 'aborted';
export interface EgressOperationTerminal {
  outcome: 'completed' | 'denied' | 'failed' | 'cancelled';
  reason?: string;
  dispatched: boolean;
}
export function createEgressOperation(options: {
  decide(terminal: EgressOperationTerminal): void;
  abort(): void;
  observe(terminal: EgressOperationTerminal): void;
}) {
  let state: EgressOperationState = 'pending';
  let terminal: EgressOperationTerminal | undefined, observed = false;
  let admission: Promise<boolean> | undefined, effectCount = 0;
  const effects = new Set<Promise<unknown>>();
  const cleanups=new Set<()=>void>();
  const active = () => state !== 'finished' && state !== 'aborted';
  const flush = () => {
    if (!terminal || observed || effectCount) return;
    observed = true; options.observe(terminal);
  };
  const finish = (outcome: EgressOperationTerminal['outcome'], reason?: string) => {
    if (!active()) return;
    if (outcome === 'completed' && state !== 'dispatched') { outcome='cancelled';reason ??= 'not_dispatched'; }
    terminal = { outcome, reason, dispatched: state === 'dispatched' };
    state = outcome === 'completed' ? 'finished' : 'aborted';
    options.decide(terminal);
    for(const release of cleanups)try{release();}catch{/* One failed release cannot retain the others. */}
    cleanups.clear();options.abort();flush();
  };
  const sendRefusal = (count:number,remaining:number) => {
    if (!active()) return 'turn_cancelled' as const;
    if (state !== 'admitted' && state !== 'dispatched') return 'call_not_admitted' as const;
    if (count > remaining || count === 0 && state !== 'dispatched' && remaining <= 0) return 'max_bytes_per_turn' as const;
    return undefined;
  };
  return {
    sendRefusal,
    ownCleanup(release:()=>void) { if(active())cleanups.add(release);else release(); },
    state: () => state, active,
    canCharge: () => state === 'admitted' || state === 'dispatched',
    dispatched: () => state === 'dispatched' || terminal?.dispatched === true,
    finish,
    admit(run: () => Promise<boolean>): Promise<boolean> {
      if (!active()) return Promise.resolve(false);
      if (state !== 'pending') return Promise.resolve(true);
      admission ??= (async () => {
        try {
          const allowed = await run();
          if (!allowed) { finish('denied','call_not_admitted');return false; }
          if (!active()) return false;
          state = 'admitted'; return true;
        } catch { finish('failed', 'proxy_error'); return false; }
      })();
      return admission;
    },
    /** The sole admission side-effect boundary. Terminal observation joins it. */
    async effect(run: () => unknown): Promise<boolean> {
      if (!active() || state !== 'pending') return false;
      effectCount++;
      let result: Promise<unknown>;
      try { result = Promise.resolve(run()); } catch (error) { result = Promise.reject(error); }
      const pending = result.finally(() => { effectCount--; effects.delete(pending); flush(); });
      effects.add(pending);
      await pending;
      return active();
    },
    /** check includes the new-connection budget fence; no await separates it from notify. */
    dispatch(remaining:number,check: () => boolean, notify: () => void): boolean {
      if (!active()) return false;
      const refusal=sendRefusal(0,remaining);
      if (refusal) { finish(refusal==='turn_cancelled'?'cancelled':'denied',refusal);return false; }
      if (!check()) return false;
      if (state === 'dispatched') return true;
      notify();
      if (!active()) return false;
      state = 'dispatched'; return true;
    },
    async settled(): Promise<void> { while (effects.size) await Promise.allSettled([...effects]); },
  };
}
