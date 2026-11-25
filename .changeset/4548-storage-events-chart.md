---
"@schlessera/brain-ui-react": minor
---

The Storage pane's "Available space over time" chart draws the server's storage events timeline (`GET /api/storage/events`, #4541) beside its own markers (#4548). Warning starts, severity steps, recoveries and ends, owner refusals and their resolutions, scope changes and maintenance runs appear at the server's times, each with its own words and tone, numbered in time order for the selected volume and tier so the event list matches the chart. An event both sources report appears once: a maintenance run is matched to its latest receipt by receipt id and phase, never by time, and a finished run is one marker. The timeline is read with history and continued with `since`; a kind the server paused is a note under the chart, not an error. An older host's 404, or any failed read, leaves the chart with its own markers and no error banner. A warning that opened before the host recorded events has no start marker, as #4541 records no start for it.
