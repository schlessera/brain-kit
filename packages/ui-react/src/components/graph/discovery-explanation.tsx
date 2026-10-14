import { Disclosure } from "@schlessera/brain-ui-kit";

export const DISCOVERY_CAPTION =
  "bands = hops · placement follows link predecessors";

/** Shared meaning in the desktop caption and phone's accessible-list header. */
export function DiscoveryExplanation() {
  return (
    <div className="flex min-w-0 flex-col gap-2 [&_.bk-control]:min-h-11 laptop:[&_.bk-control]:min-h-6">
      <span className="font-mono text-[10px] text-muted-foreground">
        {DISCOVERY_CAPTION}
      </span>
      <Disclosure label="How placement works" icon="graph">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Each band is a hop count: band 3 holds notes three outgoing links from
          the root. Lanes inside a band only make room and mean nothing. Notes
          with a visible predecessor stay inside the wedge of the hop-1 note
          they descend from, ordered like their predecessors. Wedges are grouped
          by topic, largest topic first; notes without a topic come after.
          Adjacent wedges do not necessarily share a link. Packing can push a
          note away from its predecessor, lines can cross wedges, and the layout
          can shift when the scene changes, so nearby marks do not prove a link
          or a shared parent. The dashed wedge holds notes whose predecessor is
          not shown in this scene, and their descendants. Colour follows the
          legend. Every note is also in the list.
        </p>
      </Disclosure>
    </div>
  );
}
