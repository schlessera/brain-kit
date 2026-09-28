---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-kit": minor
"@schlessera/brain-ui-react": minor
---

`show_block` gains a `map` block: 1 to 30 named places, drawn on real geography with a numbered list under them that always carries every place (#44). The model supplies places and, when a source states them, coordinates. The surface decides everything the drawing needs: one map, a pair of maps for two groups too far apart for one, or only the list, with a line that says why. The payload has no span, zoom, box, tone or numbering field.

- **ui-sdk**: `MAP_BLOCK_SCHEMA` joins the block union, and the tool's description and brief name it. `planPlaces` (from `/client`) is the pure plan behind the drawing: rows in payload order, the mode, each frame's geometry box, and whether names fit on the map. A place with no coordinates, at `0, 0` or past ±85° is listed with the reason and never pinned.
- **ui-kit**: new `PlaceMap` and `PlaceList` blocks. `MapView` gains additive props: `pinMode="number"` (numbered badges, lettered clusters such as `A·5`), `onClusters`, `letterFrom`, `coordChip`, `describe` (an accessible name, with the list as its description), `framed`, and `MapPin.n`. `mapViewBounds` exports the box the view draws. Existing `MapView` output is unchanged.
- **ui-react**: `BlockCard` draws the `map` block. It fetches each frame's geometry through the existing `/geo/coastline` route and cache. When geometry is empty or unavailable, the frame becomes a one-line note and the list still carries every place. A shared answer draws the list and asks for no geometry. `BlockCard` takes an optional `isStatic` prop for renders nothing will update.
