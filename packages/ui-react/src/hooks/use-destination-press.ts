import { useEffect, useRef } from "react";
import { useBrainUiRoot } from "../root-context.js";
import { useUIStore } from "../stores/ui-store.js";
import type { Destination, DestinationPress } from "../stores/ui-state.js";

/**
 * Runs `onPress` when `destination` is pressed while it is already shown
 * (D52 N3; `pressDestination`, `packages/ui-react/src/stores/ui-state.ts`).
 * The store has no DOM, so the mounted destination answers: it scrolls its
 * own containers to their start and moves focus with the helpers in
 * `lib/destination-start.ts`.
 *
 * Only a press recorded while this component watches the store is answered.
 * One seen at mount, or carried by a replacement root the provider switches
 * to without remounting, is taken as already answered: each root counts its
 * presses from zero, so the count alone cannot tell two roots' presses apart.
 */
export function useDestinationPress(destination: Destination, onPress: (press: DestinationPress) => void) {
  const store = useBrainUiRoot().stores.ui;
  const press = useUIStore((s) => s.destinationPress);
  const seen = useRef({ store, press });
  const handler = useRef(onPress);
  handler.current = onPress;
  useEffect(() => {
    if (seen.current.store !== store) {
      seen.current = { store, press };
      return;
    }
    if (!press || press === seen.current.press) return;
    seen.current.press = press;
    if (press.destination === destination) handler.current(press);
  }, [store, press, destination]);
}
