import preview from "#.storybook/preview";
import { FileRow } from "../../src/rows/FileRow.js";
import { QueueItemRow } from "../../src/rows/QueueItemRow.js";
import { SearchResultCard } from "../../src/evidence/SearchResultCard.js";
import { ActionCard } from "../../src/decisions/ActionCard.js";
import { Placeholder } from "../../src/states/Placeholder.js";
import { StreamingAnswer } from "../../src/conversation/StreamingAnswer.js";

const meta = preview.meta({ title: "States/GhostSweep", component: Placeholder, parameters: { layout: "padded" } });

/** Maintainer review: broad reflective sweep at 320px and desktop in both themes. */
export const Gallery = meta.story({
  render: () => (
    <div data-ghost-gallery style={{ width: "min(800px, 100%)", display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 16 }}>
      <FileRow view="loading" kind="file" label="omens.md" />
      <QueueItemRow view="loading" note="Waiting for the crew to return from the shore." />
      <SearchResultCard view="loading" snippetLength={120} />
      <ActionCard state="loading" kind="approval" title="Sail past the Sirens with wax for every member of the crew" body="Tie Odysseus to the mast before entering the passage." />
      <Placeholder ghost={[{ role: "sans", length: 5 }, { role: "sans", length: 120 }]} seed="odysseus-ramp" />
      <StreamingAnswer text="" target="Ithaca · crew reports" stoppable={false} />
    </div>
  ),
});

/** The profiling scene: all 20 rows and 6 cards fit a 412×915 viewport. */
export const Performance = meta.story({
  render: () => (
    <div data-ghost-performance style={{ width: 380, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, alignItems: "start" }}>
      <div>{Array.from({ length: 20 }, (_, i) => <FileRow key={i} view="loading" kind="file" label={`voyage-${i}.md`} />)}</div>
      <div style={{ display: "grid", gap: 6 }}>{Array.from({ length: 6 }, (_, i) => <ActionCard key={i} state="loading" title="Sail past the Sirens" body="Wax for the crew." />)}</div>
    </div>
  ),
});


export const ShortLine = meta.story({ args: { ghost: [{ role: "sans", size: 12, length: 5 }], seed: "odysseus-pixel" } });
export const LongLine = meta.story({ args: { ghost: [{ role: "sans", size: 12, length: 120 }], seed: "odysseus-pixel" } });
