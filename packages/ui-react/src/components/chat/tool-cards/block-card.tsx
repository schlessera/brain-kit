/**
 * The `show_block` result: one of the kit's answer blocks, drawn inline (D41).
 *
 * A switch typed by the contract's payload, handing each variant to its kit
 * component. That typing is the drift check the contract promised: a schema
 * field the kit does not accept fails here, and the kit's own tone unions are
 * asserted equal to the schema's lists in `tests/block-contract.test-d.ts`.
 *
 * Icons come from the model as strings; the kit's `Icon` renders an empty
 * box for a key it does not know, so unknown keys are dropped before the
 * prop is handed on. Everything else is passed through untouched: the
 * schema already rejected what the kit cannot draw.
 */

import {
  BarList,
  ComparisonTable,
  ContactCard,
  DataTable,
  ICONS,
  QuoteCard,
  Receipt,
  ScheduleList,
  StatTiles,
  StepList,
  TimelineList,
  TrendChart,
  type IconName,
} from "@schlessera/brain-ui-kit";
import type { Block, ShowBlockPayload } from "@schlessera/brain-ui-sdk/client";

/** A kit icon key, or nothing when the model named one the kit lacks. */
export function kitIcon(name: string | undefined): IconName | undefined {
  return name !== undefined && name in ICONS ? (name as IconName) : undefined;
}

/** The collapsed one-liner for the trace: `comparison · 3 columns · 4 rows`. */
export function blockSummary({ block }: ShowBlockPayload): string {
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  switch (block.kind) {
    case "comparison":
      return `comparison · ${count(block.columns.length, "column")} · ${count(block.rows.length, "row")}`;
    case "stats":
      return `stats · ${count(block.tiles.length, "tile")}`;
    case "trend":
      return `trend · ${block.label ?? block.value ?? count(block.values.length, "point")}`;
    case "table":
      return `table · ${count(block.columns.length, "column")} · ${count(block.rows.length, "row")}`;
    case "bars":
      return `bars · ${count(block.rows.length, "row")}`;
    case "receipt":
      return `receipt · ${block.title ?? count(block.rows.length, "row")}`;
    case "steps":
      return `steps · ${count(block.steps.length, "step")}`;
    case "timeline":
      return `timeline · ${count(block.items.length, "event")}`;
    case "schedule":
      return `schedule · ${count(block.groups.length, "day")}`;
    case "quote":
      return `quote · ${block.source ?? "unattributed"}`;
    case "contact":
      return `contact · ${block.label}`;
  }
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "comparison": {
      const { kind: _kind, ...props } = block;
      return <ComparisonTable {...props} />;
    }
    case "stats":
      return (
        <StatTiles
          tiles={block.tiles.map((tile) => ({ ...tile, icon: kitIcon(tile.icon) }))}
        />
      );
    case "trend": {
      const { kind: _kind, ...props } = block;
      return <TrendChart {...props} />;
    }
    case "table": {
      const { kind: _kind, ...props } = block;
      return <DataTable {...props} />;
    }
    case "bars":
      return <BarList rows={block.rows} />;
    case "receipt": {
      const { kind: _kind, titleIcon, ...props } = block;
      return <Receipt {...props} titleIcon={kitIcon(titleIcon)} />;
    }
    case "steps": {
      const { kind: _kind, ...props } = block;
      return <StepList {...props} />;
    }
    case "timeline":
      return <TimelineList items={block.items} />;
    case "schedule":
      return <ScheduleList groups={block.groups} />;
    case "quote": {
      const { kind: _kind, icon, ...props } = block;
      return <QuoteCard {...props} icon={kitIcon(icon)} />;
    }
    case "contact": {
      const { kind: _kind, contactKind, ...props } = block;
      return <ContactCard {...props} kind={contactKind} />;
    }
  }
}

/** Bound to `SHOW_BLOCK_CONTRACT`; receives the parsed payload as props. */
export function BlockCard({ block }: ShowBlockPayload) {
  return (
    <div data-block={block.kind}>
      <BlockView block={block} />
    </div>
  );
}
