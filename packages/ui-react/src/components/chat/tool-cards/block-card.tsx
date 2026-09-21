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
 * prop is handed on. Optional TEXT props are the other translation: the kit
 * ports the design's demo defaults, so a `QuoteCard` with no `source` names
 * a forecast from the Odysseus fixture world and a `ContactCard` with no
 * `label` is Penelope, and omitted `facts` or `ticks` draw a demo list. Each
 * of those components honours an empty string or an empty array as
 * "cleared", so an omitted field is handed on as `""` or `[]` rather than
 * `undefined`. Everything else is passed through untouched: the schema
 * already rejected what the kit cannot draw.
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
  // An own-property check: `"constructor" in ICONS` is true through the
  // prototype, and the kit would then try to render a function that is not
  // a component.
  return name !== undefined && Object.hasOwn(ICONS, name) ? (name as IconName) : undefined;
}

/** An omitted optional text prop, cleared rather than left to the kit's demo default. */
const text = (value: string | undefined): string => value ?? "";

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
      const { kind: _kind, footnote, ...props } = block;
      return <ComparisonTable {...props} footnote={text(footnote)} />;
    }
    case "stats":
      return (
        <StatTiles
          tiles={block.tiles.map((tile) => ({ ...tile, icon: kitIcon(tile.icon) }))}
        />
      );
    case "trend": {
      const { kind: _kind, label, value, ticks, ...props } = block;
      return <TrendChart {...props} label={text(label)} value={text(value)} ticks={ticks ?? []} />;
    }
    case "table": {
      const { kind: _kind, ...props } = block;
      return <DataTable {...props} />;
    }
    case "bars":
      return <BarList rows={block.rows} />;
    case "receipt": {
      const { kind: _kind, title, titleIcon, footnote, ...props } = block;
      return (
        <Receipt
          {...props}
          title={text(title)}
          titleIcon={kitIcon(titleIcon)}
          footnote={text(footnote)}
        />
      );
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
      const { kind: _kind, icon, source, locator, note, ...props } = block;
      return (
        <QuoteCard
          {...props}
          source={text(source)}
          locator={text(locator)}
          note={text(note)}
          icon={kitIcon(icon)}
        />
      );
    }
    case "contact": {
      const { kind: _kind, contactKind, role, facts, ...props } = block;
      return <ContactCard {...props} kind={contactKind} role={text(role)} facts={facts ?? []} />;
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
