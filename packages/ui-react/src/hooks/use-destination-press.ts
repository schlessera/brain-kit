import { useEffect, useRef } from "react";
import { useUIStore } from "../stores/ui-store.js";
import type { Destination, DestinationPress } from "../stores/ui-state.js";

/**
 * Runs `onPress` when `destination` is pressed while it is already shown
 * (D52 N3; `pressDestination`, `packages/ui-react/src/stores/ui-state.ts`).
 * The store has no DOM, so the mounted destination answers: it scrolls its
 * own containers to their start and moves focus with the helpers in
 * `lib/destination-start.ts`.
 *
 * A press recorded before this component mounted is not answered: the count
 * it last saw starts at the store's current one.
 */
export function useDestinationPress(destination: Destination, onPress: (press: DestinationPress) => void) {
  const press = useUIStore((s) => s.destinationPress);
  const seen = useRef(press?.n ?? 0);
  const handler = useRef(onPress);
  handler.current = onPress;
  useEffect(() => {
    if (!press || press.n === seen.current) return;
    seen.current = press.n;
    if (press.destination === destination) handler.current(press);
  }, [press, destination]);
}
