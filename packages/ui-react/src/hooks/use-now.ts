import { useEffect, useState } from "react";

/** All subscribed setters, driven by ONE shared interval. */
const listeners = new Set<(now: number) => void>();
let ticker: ReturnType<typeof setInterval> | null = null;

/**
 * A ticking `Date.now()` for live elapsed labels. Every consumer shares a
 * single setInterval (created on the first subscriber's cadence, torn down
 * with the last), so a screen full of running rows costs one timer, and all
 * their labels tick in the same frame.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    listeners.add(setNow);
    if (!ticker) {
      ticker = setInterval(() => {
        const t = Date.now();
        for (const listener of listeners) listener(t);
      }, intervalMs);
    }
    return () => {
      listeners.delete(setNow);
      if (listeners.size === 0 && ticker) {
        clearInterval(ticker);
        ticker = null;
      }
    };
  }, [intervalMs]);
  return now;
}
