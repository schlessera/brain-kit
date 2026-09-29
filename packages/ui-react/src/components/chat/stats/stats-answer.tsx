import { BarList, Callout, Label, Receipt, StatTiles, TrendChart } from "@schlessera/brain-ui-kit";
import type { ReactNode } from "react";
import { useMediaQuery } from "../../../hooks/use-media-query.js";
import { RECEIPT_KEY_WIDTH, type StatsSection } from "./compose-stats.js";

/**
 * The /stats answer, drawn from the kit (#97). Every decision about what is
 * shown lives in `composeStatsAnswer`; this only chooses the component and
 * the layout knobs the block contract leaves to the surface.
 *
 * Each tile row is its own two-tile group. The row break is the source
 * break — corpus above, runtime below — and a group of two never lands in
 * the ragged three-and-one a four-tile group takes between ~378 and 506px.
 */
export function StatsAnswer({ sections }: { sections: StatsSection[] }) {
  // A phone gives the bar 56px, so a type name keeps about 27 characters on
  // its first line; a desktop column has room for a bar that reads as one.
  const wide = useMediaQuery("(min-width: 640px)");
  return (
    <div className="space-y-3" data-stats-answer="">
      {sections.map((section, i) => (
        <div key={i} data-stats-section={section.kind}>
          {draw(section, wide)}
        </div>
      ))}
    </div>
  );
}

function draw(section: StatsSection, wide: boolean): ReactNode {
  switch (section.kind) {
    case "software": {
      const { client, server, state, detail, tone } = section.details;
      return (
        <section aria-label="Software versions" style={{ minWidth: 0, userSelect: "text" }}>
          <Receipt title="Software" titleIcon="health" titleTone={tone} keyWidth={RECEIPT_KEY_WIDTH}
            rows={[
              { k: "Client release", v: client.release ?? "Unknown" },
              { k: "Client build", v: client.sourceCommit ?? "Unknown" },
              { k: "Server release", v: server.release ?? "Unknown" },
              { k: "Server build", v: server.sourceCommit ?? "Unknown" },
            ]}
            footnote={`${state}. ${detail}`} footIcon="scope" footTone={tone}
          />
        </section>
      );
    }
    case "callout":
      return (
        <Callout tone={section.tone} variant={section.variant}>
          <strong>{section.title}</strong> {withCode(section.body)}
        </Callout>
      );
    case "tiles":
      return <StatTiles tiles={section.tiles} minTile={120} />;
    case "bars":
      return (
        <div className="space-y-2">
          <Label text={section.title} meta={section.meta} />
          <BarList rows={section.rows} barWidth={wide ? 120 : 56} valueWidth={40} />
        </div>
      );
    case "trend":
      return (
        <section aria-label={`Trend: ${section.label}`} style={{ minWidth: 0 }}>
          <TrendChart label={section.label} value={section.value} values={section.values} ticks={section.ticks} tone={section.tone} />
        </section>
      );
    case "receipt":
      return (
        <Receipt
          title={section.title}
          titleIcon="health"
          titleTone="teal"
          rows={section.rows}
          keyWidth={RECEIPT_KEY_WIDTH}
          footnote={section.footnote ?? ""}
          footIcon="scope"
          footTone={section.footTone ?? "teal"}
        />
      );
  }
}

/** `brain audit` in the copy as code, the rest as text. */
function withCode(text: string): ReactNode[] {
  return text.split("`").map((piece, i) => (i % 2 ? <code key={i}>{piece}</code> : piece));
}
