# Feature captures

The [capture data](#capture-data) in this Markdown file is the editorial
catalogue for public README and website captures. Its nine still IDs are actual Storybook
IDs; each entry names its export, fictional inputs, crop, observable readiness,
filename, consumer, alt text and caption. The ranked-question sequence names a
real local UI interaction. These data are internal to the repository and the
capture implementation; they do not extend a published package API.

The [capture decision](../decisions/feature-captures.md) explains the source and
evidence rules. The implementation belongs to
[#614](https://github.com/schlessera/brain-kit/issues/614), and public integration
to [#615](https://github.com/schlessera/brain-kit/issues/615). The catalogue
contains configuration and source requirements. GitHub holds ownership,
prerequisites and acceptance of the work.

## Generate captures

From the repository root, install the frozen dependencies and prepare the public
font inputs once. Preparation downloads the checksum-pinned fonts and original
upstream notices into an external cache; generation uses only verified local
bytes and runs with Docker networking disabled.

```sh
bun install --frozen-lockfile
bun run capture:fonts
bun run captures --all
```

`--list` shows the nine stills, the ranking gesture and both runtime IDs. The
default output is ignored `tmp/feature-captures/`, with a `manifest.json` that
records provenance per artifact. Select IDs without regenerating other outputs:

```sh
bun run captures --id screens-chat-answer--chat-answer,screens-file-viewer--file-viewer
bun run captures --id approval-roundtrip --theme light --viewport 600x1000
bun run capture:verify
```

Runtime screenshots materialize both the initial and temporary file-link fragment
surfaces before restoring
their final styles and rejecting changed content or geometry before the existing
visibility and three-identical-frame checks. This editorial preparation handles
the controlled [native paint-history difference](../decisions/approval-capture-raster.md).
`capture:verify` additionally compares actual approval effects, history and exact
PNGs across ten fresh-browser pairs of both controlled paint histories; each
`paint-history/pair-N/` directory retains its manifests and original PNGs, and
the surrounding `paint-history/` artifacts retain
the native measurements and original screenshots.

`--out` selects a dedicated empty or previously managed output directory.
`--font-cache` selects the same prepared cache for preparation, generation and
verification. A theme override changes the filename; a viewport override adds
its dimensions. Still viewports are the rendering canvas: approved composition
crops retain their source dimensions and fail if the canvas cannot contain them.
Component-stage CSS measurements round to their declared image pixels; phone
border boxes are exact. Runtime transcripts use the full document height.

Docker and the installed Bun binary are required. Builds and Chromium run in
the image declared by the shared visual runner, with the frozen installed
packages. The manifest records the image ID/digests, browser and Bun binaries,
font lock, actual source bytes and build bytes. A checkout admits one capture
at a time because builds share its output. After an interrupted process, verify
that no capture is running before removing `tmp/.feature-capture-lock`.

Editorial Chromium uses `--disable-partial-raster`, recorded in the manifest.
Without it, otherwise unchanged approval reloads differed at rounded-border
raster edges. This setting follows the browser's
[documented tooling flags](https://github.com/GoogleChrome/chrome-launcher/blob/main/docs/chrome-flags-for-tools.md#rendering--gpu)
and keeps exact output comparison; regression-browser settings are separate.

The ranking gesture samples 72 actual frames at 12 fps over six seconds. The
image-provided FFmpeg encodes high-quality JPEG samples; PNG frame hashes and
before/after stills retain the gesture evidence. No frame substitutes a staged
order. The capture/search transcript contains the real CLI results and written
Markdown. Approval frames come from the mounted chat client, with independent
allow/deny turns, actual executor effects, recorded principals and backend
history replayed after reload. Runtime stills wait for the actual connection
and three consecutive identical paints after text and font readiness.

`capture:verify` runs representative captures twice and requires identical PNG,
video and capture/search evidence bytes. Approval evidence retains the app's
randomly generated principal ID; verification permits only that field to vary,
requires one correlated nonempty principal for both decisions in each run, and
compares the remaining evidence exactly. Each run keeps its actual build and
source provenance. Use `--all` to verify the entire catalogue. CI runs the same
command; font preparation is an explicit dependency step outside the keyless
test suite. Missing sources, unready stories, fonts, clipped required text,
blank pixels and observed executor/store mismatches fail with the recipe ID.

These commands produce artifacts for review. They do not copy files into public
pages or accept final launch assets. Integration and corpus prerequisites remain
in the linked issues.

## Choose the evidence

| Recipe ID | Feature illustrated | Consumer | Theme and output |
| --- | --- | --- | --- |
| `screens-chat-answer--chat-answer` | Structured answer with source references | README Optional chat UI | Dark, `readme-chat-answer-dark.png`, 390 × 844 |
| `screens-file-viewer--file-viewer` | Frontmatter, related notes and file affordances | README Optional chat UI | Dark, `readme-file-viewer-dark.png`, 390 × 844 |
| `screens-actions-triage--actions-triage` | Approval controls and action/queue presentation | Homepage approvals/activity slot | Dark, `actions-triage-dark.png`, 390 × 844 |
| `screens-run-detail--run-detail` | Run summary, tool trace and stalled request | Homepage observability slot | Paper, `run-detail-light.png`, 390 × 844 |
| `screens-first-run--first-run` | Empty-chat presentation and discovery affordances | Homepage get-started slot | Paper, `first-run-light.png`, 390 × 844 |
| `screens-weekly-review--weekly-review` | Review figures, a visible write effect and receipt | Homepage review slot | Paper, `weekly-review-light.png`, 390 × 844 |
| `screens-morning-digest--morning-digest` | Digest, activity and schedule composition | Homepage daily-review slot | Dark, `morning-digest-dark.png`, 390 × 844 |
| `evidence-searchresultcard--result-set` | Paths, highlighted snippets and fixture scores | Homepage capture/search slot | Paper, `search-results-light.png`, 360 × 320 |
| `desktop-commandpalette--write-selected` | Command groups and a selected write effect | Homepage command-discovery slot | Dark, `command-palette-dark.png`, 408 × 331 |

The homepage consumers are editorial slots for
[#612](https://github.com/schlessera/brain-kit/issues/612), whose page design
selects their placement. They introduce no website framework, destination,
domain or additional landing page. The two README entries preserve
[#609's selection](https://github.com/schlessera/brain-kit/issues/609): beside
Optional chat UI, after its availability notice.

Each composition uses the shipped component source with Storybook fixture
props. Its callbacks are mocked. Captions say that clearly: the search scores
are staged, the run figures are fictional, and an approval card is presentation
of an approval. Product execution needs the runtime sources described by the
catalogue's `harness_requirements`. Consumers retain the README's experimental
status, hosted-interface availability and provider privacy/cost limits.

The first-run illustration has an empty chat and a fictional 4,812-document
corpus. Its reassurance, Install button and voice composer are fixture content.
Use its supplied caption together with the product documentation; it does not
supply an onboarding, privacy, offline, push or voice-service guarantee.

## Preserve the declared crop

A phone story has a 390 × 844 content box and a 9-pixel bezel on every side.
The `phone` profile renders in an 800 × 1000 viewport at scale 1, verifies the
408 × 862 outer box and crops its interior. The result includes the actual
status and navigation furniture the story renders, without the outer bezel.
The component profiles crop their whole stage element, with expected dimensions
in the catalogue. They keep the component's source spacing and typography.

Every fresh source render keeps the initial scroll position, default closed
disclosures and source args. The recipe's `claim_limits` describe the crop:
chat's map and suggested next steps are below its initial frame; file viewer
contains early backlinks with later rows reachable by scrolling; action, run,
review and digest screens also have content below the fold. Alt text describes
visible content. A caption or consumer wanting another state needs its own
explicit recipe and review.

## Make readiness observable

Resolve the browser image from `IMAGE` in `scripts/visual.mjs` and cross-check
the installed Playwright dependency, following the shared browser runner.
Resolve the clock from `REFERENCE_DATE` / `REFERENCE_INSTANT` in
`packages/ui-kit/fixtures/time.ts`. Locale is `en-GB`, timezone is the fixture's
fixed UTC+2 (`Etc/GMT-2`), device scale is 1, and reduced motion is enabled.
Story furniture's literal clock remains as its source defines it.

The preview's three font families and required weights are listed in the
catalogue. The current preview head loads remote CSS, so the capture runner
resolves, hashes and locally serves the exact font bytes, with upstream notices
and provenance. During generation, allow the local fixture source and pinned
assets; an unexpected external request fails the recipe. Confirm that every
required face loaded before measuring geometry. `document.fonts.ready` alone
can succeed after a download failure while fallback fonts draw different text.

Await the source's render and play completion, then actual required text and
controls, settled assets and canvas geometry. The theme goes through the
Storybook `theme` global; verify `data-theme` and computed `color-scheme` after
render. Wait for two animation frames after layout settles and disable
nonessential animation for stills. A fixed sleep, successful HTTP response or
nonempty DOM alone is insufficient readiness.

Verify the required text intersects the declared crop and its scrolling
container; an off-screen element can pass a generic visibility predicate.
Check image completion, crop dimensions, useful nonblank pixels and absence of
source/browser errors. Missing stories, fonts, labels or geometry identify the
recipe and fail. Keep failures observable rather than capturing an error
page, loading state or substitute markup.

## Use motion for the gesture

`rank-five-reorder` is a six-second dark clip of the actual
`decisions-ranked-question--rank-untouched` source. At 360 × 900, pick up
Circe's island by its third-position handle, drag it to the first row, release
and hold the resulting order. Verify the same five item IDs survive and the
live announcement names position 1 of 5. Submission stays untouched.

The lifted handle and changing drop position explain the gesture. Preserve its
local pointer feedback while suppressing unrelated infinite animation. The
provided before/after stills and keyboard/tap description are the accessible,
reduced-motion fallback. Give consumers explicit playback controls and the
caption; no autoplay or audio is needed. Other selected features read clearly
as stills, so the catalogue adds no scrolling montage or synthetic model
stream.

## Runtime source requirements

The two `harness_requirements` scope actual capture/search and approval-resolution
evidence for #614. They name current source files, inputs, sequence, observation
and failure conditions. They are separate from the nine composed stills. The generator supplies their
real source harnesses, making both IDs selectable.

Capture/search runs real index/add/search operations against isolated Odysseus
files, then observes written Markdown and a nonempty FTS result. Approval
resolution reaches the real client/server boundary with a scripted supported
backend and isolated store, then observes allow/deny effects and reload.
Neither requires a model credential or external tool. These are fixture
harnesses for existing behavior; they introduce no product feature or provider
seam. #614 owns implementation and the meaningful mutation receipts.

## Keep generation reviewable

The generator reads the uniquely marked JSON block in this Markdown source,
validates it and selects IDs/themes/profiles from the catalogue. It
writes stable filenames to a dedicated editorial output directory. It records
recipe data/hash, source commit and dirty state, fixture/font bytes, lockfile,
build identity, browser image/digest/version, locale/timezone/time, dimensions
and readiness evidence in its manifest. A screenshot from modified source must
retain that provenance. Generation produces reviewable artifacts.

Keep that output separate from
[`packages/ui-kit/tests/visual/__screenshots__/`](../../packages/ui-kit/tests/visual/README.md)
and retain the regression runner's purpose. Captures never update baselines,
change product markup for marketing or publish automatically. Final public
example outputs/captures follow the shared Odysseus ruling and
[#608's sequencing](https://github.com/schlessera/brain-kit/issues/608), including
[#625](https://github.com/schlessera/brain-kit/issues/625). #615 owns asset
integration, responsive sizing, freshness and launch acceptance.

## Capture data

This uniquely marked JSON block is configuration for the repository capture
implementation. It keeps captions and alt text in the Markdown editorial
source. A generated manifest may copy the selected data together with its
source hash; the capture runner must reject missing, duplicate or invalid blocks.

<!-- feature-capture-data:start -->
```json
{
  "purpose": "Editorial capture data for the public project.",
  "environment": {
    "browser_pin_source": "scripts/visual.mjs (IMAGE)",
    "browser_package_source": "packages/ui-kit/package.json (devDependencies.playwright)",
    "fixture_clock_source": "packages/ui-kit/fixtures/time.ts (REFERENCE_DATE, REFERENCE_INSTANT)",
    "locale": "en-GB",
    "timezone": "Etc/GMT-2",
    "device_scale_factor": 1,
    "reduced_motion": "reduce",
    "still_animations": "disabled",
    "font_source": "packages/ui-kit/.storybook/preview-head.html",
    "font_families": {
      "DM Serif Text": [
        "400",
        "400 italic"
      ],
      "Plus Jakarta Sans": [
        "400",
        "500",
        "600",
        "700"
      ],
      "JetBrains Mono": [
        "400",
        "500",
        "600"
      ]
    },
    "font_delivery": "Resolve and hash the actual preview font bytes before capture; serve pinned local assets and record upstream notices. No live font requests or fallback-font acceptance during generation.",
    "network": "Local fixture source and pinned assets only; reject unexpected external requests."
  },
  "profiles": {
    "phone": {
      "viewport": {
        "width": 800,
        "height": 1000
      },
      "crop": {
        "selector": "#storybook-root > div",
        "inset_px": 9,
        "expected_element": {
          "width": 408,
          "height": 862
        },
        "output": {
          "width": 390,
          "height": 844
        }
      }
    },
    "search-cards": {
      "viewport": {
        "width": 800,
        "height": 1000
      },
      "crop": {
        "selector": "#storybook-root > div",
        "inset_px": 0,
        "expected_element": {
          "width": 360,
          "height": 320
        },
        "output": {
          "width": 360,
          "height": 320
        }
      }
    },
    "palette": {
      "viewport": {
        "width": 800,
        "height": 1000
      },
      "crop": {
        "selector": "#storybook-root > div",
        "inset_px": 0,
        "expected_element": {
          "width": 408,
          "height": 331
        },
        "output": {
          "width": 408,
          "height": 331
        }
      }
    }
  },
  "recipes": [
    {
      "id": "screens-chat-answer--chat-answer",
      "features": [
        "structured answers",
        "source references"
      ],
      "source": {
        "kind": "storybook-composition",
        "story_id": "screens-chat-answer--chat-answer",
        "module": "packages/ui-kit/stories/screens/ChatAnswer.stories.tsx",
        "export": "ChatAnswer",
        "fixture_modules": [
          "packages/ui-kit/fixtures/files.ts",
          "packages/ui-kit/fixtures/notes.ts",
          "packages/ui-kit/fixtures/places.ts",
          "packages/ui-kit/fixtures/runs.ts",
          "packages/ui-kit/fixtures/search.ts"
        ]
      },
      "theme": "dark",
      "profile": "phone",
      "inputs": "base story args and fixtures; fresh render, initial scroll and default disclosure state",
      "readiness": {
        "text_case_sensitive": false,
        "required_visible_text": [
          "Brain",
          "Where did Circe warn me about Scylla",
          "knowledge/teiresias-forecast.md",
          "line 12"
        ]
      },
      "output": "readme-chat-answer-dark.png",
      "consumer": {
        "page": "README.md",
        "slot": "Optional chat UI; after the availability notice"
      },
      "alt": "Chat-answer composition for Odysseus's question about Circe's warning, showing source counts and a quotation with its document and line reference.",
      "caption": "Structured answer assembled from fictional Odyssey fixtures. The quotation retains its document and line reference; this still image demonstrates the UI kit composition.",
      "claim_limits": "Map and suggested next steps are below this initial crop; the disclosure starts closed."
    },
    {
      "id": "screens-file-viewer--file-viewer",
      "features": [
        "file ownership",
        "frontmatter",
        "backlinks"
      ],
      "source": {
        "kind": "storybook-composition",
        "story_id": "screens-file-viewer--file-viewer",
        "module": "packages/ui-kit/stories/screens/FileViewer.stories.tsx",
        "export": "FileViewer",
        "fixture_modules": [
          "packages/ui-kit/fixtures/files.ts",
          "packages/ui-kit/fixtures/notes.ts"
        ]
      },
      "theme": "dark",
      "profile": "phone",
      "inputs": "base story args and fixtures; fresh render, initial scroll and default disclosure state",
      "readiness": {
        "text_case_sensitive": false,
        "required_visible_text": [
          "Scylla or Charybdis",
          "type: decision",
          "Linked from",
          "Ask about this file"
        ]
      },
      "output": "readme-file-viewer-dark.png",
      "consumer": {
        "page": "README.md",
        "slot": "Optional chat UI; beside the chat-answer still"
      },
      "alt": "File-viewer composition of Odysseus's strait decision, showing frontmatter, related notes and an Ask about this file button.",
      "caption": "Odysseus's strait decision as a UI kit file-viewer composition, with frontmatter and backlinks from fictional fixtures.",
      "claim_limits": "Later backlink rows require scrolling. PathRef labels and mocked callbacks do not demonstrate file navigation."
    },
    {
      "id": "screens-actions-triage--actions-triage",
      "features": [
        "approval controls",
        "action and queue presentation"
      ],
      "source": {
        "kind": "storybook-composition",
        "story_id": "screens-actions-triage--actions-triage",
        "module": "packages/ui-kit/stories/screens/ActionsTriage.stories.tsx",
        "export": "ActionsTriage",
        "fixture_modules": [
          "packages/ui-kit/fixtures/actions.ts",
          "packages/ui-kit/fixtures/files.ts"
        ]
      },
      "theme": "dark",
      "profile": "phone",
      "inputs": "base story args and fixtures; fresh render, initial scroll and default disclosure state",
      "readiness": {
        "text_case_sensitive": false,
        "required_visible_text": [
          "Actions",
          "Outside envelope",
          "Fetch once",
          "Skip it",
          "dead letter"
        ]
      },
      "output": "actions-triage-dark.png",
      "consumer": {
        "page": "public homepage",
        "slot": "Approvals and activity evidence slot (#612/#615)"
      },
      "alt": "Actions composition for Odysseus showing a permission request, its proposed change, Fetch once and Skip it controls, and blocked and failed rows.",
      "caption": "Fictional Actions UI kit composition. Approval and queue controls use mocked handlers; this image illustrates presentation.",
      "claim_limits": "Later policy cards are below the crop. Displayed queue states do not establish a durable autonomous workflow."
    },
    {
      "id": "screens-run-detail--run-detail",
      "features": [
        "run observability",
        "tool trace"
      ],
      "source": {
        "kind": "storybook-composition",
        "story_id": "screens-run-detail--run-detail",
        "module": "packages/ui-kit/stories/screens/RunDetail.stories.tsx",
        "export": "RunDetail",
        "fixture_modules": [
          "packages/ui-kit/fixtures/actions.ts",
          "packages/ui-kit/fixtures/runs.ts"
        ]
      },
      "theme": "light",
      "profile": "phone",
      "inputs": "base story args and fixtures; fresh render, initial scroll and default disclosure state",
      "readiness": {
        "text_case_sensitive": false,
        "required_visible_text": [
          "researcher",
          "Tool timeline",
          "brain_search",
          "needs approval"
        ]
      },
      "output": "run-detail-light.png",
      "consumer": {
        "page": "public homepage",
        "slot": "Run observability evidence slot (#612/#615)"
      },
      "alt": "Run-detail composition for the researcher, showing a stalled run, five tool steps and the start of a permission request.",
      "caption": "Fictional researcher run in the paper theme, assembled from UI kit components. Trace, time and cost values come from fixtures.",
      "claim_limits": "Approval controls and held work extend below the initial crop. No live execution, measured cost or completion is demonstrated."
    },
    {
      "id": "screens-first-run--first-run",
      "features": [
        "empty-chat presentation",
        "discovery affordances"
      ],
      "source": {
        "kind": "storybook-composition",
        "story_id": "screens-first-run--first-run",
        "module": "packages/ui-kit/stories/screens/FirstRun.stories.tsx",
        "export": "FirstRun",
        "fixture_modules": [
          "packages/ui-kit/fixtures/actions.ts",
          "packages/ui-kit/fixtures/files.ts"
        ]
      },
      "theme": "light",
      "profile": "phone",
      "inputs": "base story args and fixtures; fresh render, initial scroll and default disclosure state",
      "readiness": {
        "text_case_sensitive": false,
        "required_visible_text": [
          "What do you need to know?",
          "What happened since Troy?",
          "Process 3 loose omens",
          "Install"
        ]
      },
      "output": "first-run-light.png",
      "consumer": {
        "page": "public homepage",
        "slot": "Getting started illustration (#612/#615)"
      },
      "alt": "First-run composition with a question, three fictional Odyssey launchers, an install prompt and a voice composer.",
      "caption": "First-run UI kit composition staged with Odysseus's fictional records and mocked controls. Product privacy and installation behavior follow the product documentation.",
      "claim_limits": "The document count and reassurance are fixture copy. This is an empty-chat composition, not an empty corpus, onboarding interview, working installation or voice service."
    },
    {
      "id": "screens-weekly-review--weekly-review",
      "features": [
        "review composition",
        "effect labels"
      ],
      "source": {
        "kind": "storybook-composition",
        "story_id": "screens-weekly-review--weekly-review",
        "module": "packages/ui-kit/stories/screens/WeeklyReview.stories.tsx",
        "export": "WeeklyReview",
        "fixture_modules": [
          "packages/ui-kit/fixtures/actions.ts",
          "packages/ui-kit/fixtures/files.ts",
          "packages/ui-kit/fixtures/money.ts",
          "packages/ui-kit/fixtures/week.ts"
        ]
      },
      "theme": "light",
      "profile": "phone",
      "inputs": "base story args and fixtures; fresh render, initial scroll and default disclosure state",
      "readiness": {
        "text_case_sensitive": false,
        "required_visible_text": [
          "This week",
          "What changed",
          "Write rule",
          "write_policy",
          "Revert"
        ]
      },
      "output": "weekly-review-light.png",
      "consumer": {
        "page": "public homepage",
        "slot": "Review evidence slot (#612/#615)"
      },
      "alt": "Weekly-review composition for Odysseus showing fictional spend, answered decisions, a suggested rule with its write effect and a prior rule receipt.",
      "caption": "Fictional weekly-review UI kit composition. The visible write_policy effect and receipt illustrate controls; figures and callbacks are fixture data.",
      "claim_limits": "The end of the carried-work list and footnote are below the crop. The buttons do not persist a policy in this story."
    },
    {
      "id": "screens-morning-digest--morning-digest",
      "features": [
        "digest composition",
        "activity and schedule"
      ],
      "source": {
        "kind": "storybook-composition",
        "story_id": "screens-morning-digest--morning-digest",
        "module": "packages/ui-kit/stories/screens/MorningDigest.stories.tsx",
        "export": "MorningDigest",
        "fixture_modules": [
          "packages/ui-kit/fixtures/actions.ts",
          "packages/ui-kit/fixtures/events.ts",
          "packages/ui-kit/fixtures/files.ts"
        ]
      },
      "theme": "dark",
      "profile": "phone",
      "inputs": "base story args and fixtures; fresh render, initial scroll and default disclosure state",
      "readiness": {
        "text_case_sensitive": false,
        "required_visible_text": [
          "This morning",
          "Overnight",
          "Wind service unreachable",
          "Today",
          "Launch the raft"
        ]
      },
      "output": "morning-digest-dark.png",
      "consumer": {
        "page": "public homepage",
        "slot": "Daily review evidence slot (#612/#615)"
      },
      "alt": "Morning-digest composition for Odysseus with waiting items, the fictional crew ledger and spend, overnight activity and today's schedule.",
      "caption": "Odysseus's morning digest assembled from fictional UI kit fixtures. The activity, schedule and figures are staged values.",
      "claim_limits": "The final schedule entry and digest footnote are below the crop. This still does not demonstrate scheduled delivery, push notifications or live voice transcription."
    },
    {
      "id": "evidence-searchresultcard--result-set",
      "features": [
        "search-result presentation",
        "highlighted source snippets"
      ],
      "source": {
        "kind": "storybook-composition",
        "story_id": "evidence-searchresultcard--result-set",
        "module": "packages/ui-kit/stories/evidence/SearchResultCard.stories.tsx",
        "export": "ResultSet",
        "fixture_modules": [
          "packages/ui-kit/fixtures/search.ts"
        ]
      },
      "theme": "light",
      "profile": "search-cards",
      "inputs": "base story args and fixtures; fresh render, initial scroll and default disclosure state",
      "readiness": {
        "text_case_sensitive": false,
        "required_visible_text": [
          "knowledge/scylla.md",
          "decisions/scylla-or-charybdis.md",
          "voyage/day-1043-strait.md"
        ]
      },
      "output": "search-results-light.png",
      "consumer": {
        "page": "public homepage",
        "slot": "Capture and search evidence slot (#612/#615)"
      },
      "alt": "Three fictional Odyssey search-result cards with document paths, highlighted snippets and relevance scores.",
      "caption": "Search-result card composition from fictional Odyssey fixtures. Paths, highlights and scores are staged; retrieval quality is evaluated separately.",
      "claim_limits": "A component composition without app chrome or an executed search. Do not describe the fixture scores as measured retrieval results."
    },
    {
      "id": "desktop-commandpalette--write-selected",
      "features": [
        "command discovery",
        "visible write effects"
      ],
      "source": {
        "kind": "storybook-composition",
        "story_id": "desktop-commandpalette--write-selected",
        "module": "packages/ui-kit/stories/desktop/CommandPalette.stories.tsx",
        "export": "WriteSelected",
        "fixture_modules": [
          "packages/ui-kit/fixtures/files.ts"
        ]
      },
      "theme": "dark",
      "profile": "palette",
      "inputs": "base story args and fixtures; fresh render, initial scroll and default disclosure state",
      "readiness": {
        "text_case_sensitive": false,
        "required_visible_text": [
          "scylla",
          "Jump to",
          "Ask",
          "Run",
          "enqueue",
          "reindex"
        ]
      },
      "output": "command-palette-dark.png",
      "consumer": {
        "page": "public homepage",
        "slot": "Command discovery evidence slot (#612/#615)"
      },
      "alt": "Command-palette composition with Jump to, Ask and Run groups; the selected crew-count edit carries an enqueue effect.",
      "caption": "Fictional command-palette UI kit composition. The selected write displays its effect; callbacks are mocked.",
      "claim_limits": "A palette component crop, not the assembled desktop app or proof that a command executes."
    }
  ],
  "demo_sequences": [
    {
      "id": "rank-five-reorder",
      "source": {
        "kind": "storybook-interaction",
        "story_id": "decisions-ranked-question--rank-untouched",
        "module": "packages/ui-kit/stories/decisions/AskUserRankCard.stories.tsx",
        "export": "RankUntouched",
        "fixture_modules": [
          "packages/ui-kit/fixtures/ranking.ts"
        ]
      },
      "consumer": {
        "page": "public homepage",
        "slot": "Structured input interaction (#612/#615)"
      },
      "theme": "dark",
      "viewport": {
        "width": 360,
        "height": 900
      },
      "duration_seconds": 6,
      "output": "rank-five-reorder-dark.webm",
      "steps": [
        {
          "second": 0,
          "action": "Fresh five-item state; all rows and instructions visible."
        },
        {
          "second": 1,
          "action": "Pointer down on the Reorder handle for Circe’s island, position 3 of 5."
        },
        {
          "second": 2,
          "action": "Move the captured pointer to the first row over one second; retain the lifted-row feedback."
        },
        {
          "second": 3,
          "action": "Release; wait for Circe’s island, position 1 of 5 and the live announcement."
        },
        {
          "second": 4,
          "action": "Hold the resulting order until the six-second end; leave submission untouched."
        }
      ],
      "readiness": [
        "All five labels visible, required fonts loaded and initial story play settled.",
        "After release, same five ids remain; Circe’s island is first and the live announcement names position 1 of 5."
      ],
      "alt": "Circe’s island moves from third to first by dragging its handle in a five-choice ranked question.",
      "caption": "Ranked-input interaction with fictional Odyssey choices. The clip demonstrates local UI reordering; it leaves submission untouched.",
      "why_motion": "The lifted handle, pointer capture and changing drop position explain the gesture; before/after stills show only its result.",
      "fallback": {
        "before": "rank-five-before-dark.png",
        "after": "rank-five-after-dark.png",
        "description": "Move Circe’s island from third to first. Tap an item then its destination, or focus it and press 1, as keyboard alternatives."
      }
    }
  ],
  "harness_requirements": [
    {
      "id": "capture-search-keyless",
      "feature": "Capture a note and retrieve its actual indexed content.",
      "source": [
        "packages/core/src/cli/commands/add.ts",
        "packages/core/src/cli/commands/search.ts",
        "packages/core/tests/cli-harness.ts",
        "docs/quickstart.md",
        "scripts/captures/core-fixture.ts",
        "packages/ui-kit/fixtures/notes.ts",
        "scripts/captures/runtime-server.ts"
      ],
      "inputs": "An isolated Odysseus fixture brain from the shared corpus policy, without API keys or external networking. Fixed reference date and one unique raft-supplies note.",
      "sequence": "Index; run the actual add command; verify the written Markdown; run search in FTS mode; verify the captured note path and nonempty matching text in the actual result.",
      "capture": "A fixture app wired to these actual results or a transcript of the actual commands. Preserve provenance and distinguish FTS from model-generated answers.",
      "acceptance": "Use real filesystem/index outputs; fail if capture, indexing or retrieval is removed. Do not reuse the composed SearchResultCard scores as evidence.",
      "consumer": "README first capture/search and public homepage capture/search; implementation belongs to #614 and final example acceptance follows #625.",
      "theme": "light",
      "viewport": {
        "width": 960,
        "height": 1200
      },
      "outputs": [
        "capture-search-light.png",
        "capture-search-evidence.json"
      ]
    },
    {
      "id": "approval-roundtrip",
      "feature": "A real tool approval resolves and its result persists through reload.",
      "source": [
        "packages/ui-react/src/components/chat/tool-views.tsx",
        "packages/ui-react/src/components/chat/chat-page.tsx",
        "packages/ui-server/src/app.ts",
        "scripts/captures/runtime-client.ts",
        "scripts/captures/runtime-server.ts",
        "scripts/captures/runtime.ts"
      ],
      "inputs": "A local fixture app, supported scripted AgentBackend, isolated session/activity store and one nonempty tool request. No model credentials or real external tool.",
      "sequence": "Reach the mounted tool request through the client; display its target/change; resolve allow and deny in independent runs; verify the observed executor/store result and reload.",
      "capture": "The actual app state before and after resolution, with the effect or refusal visible. Bind each frame to its fixture request and principal.",
      "acceptance": "Removing the approval route, executor guard or store persistence must change the observed result. A mocked ApprovalCard click or an earlier auth response is insufficient.",
      "consumer": "Public homepage approvals/activity; scoped fixture harness work for #614, using existing supported behavior.",
      "theme": "dark",
      "viewport": {
        "width": 480,
        "height": 960
      },
      "outputs": [
        "approval-allow-before-dark.png",
        "approval-allow-after-dark.png",
        "approval-allow-reload-dark.png",
        "approval-deny-before-dark.png",
        "approval-deny-after-dark.png",
        "approval-deny-reload-dark.png",
        "approval-evidence.json"
      ]
    }
  ]
}
```
<!-- feature-capture-data:end -->
