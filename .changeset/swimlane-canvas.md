---
"@schlessera/brain-module-diagrams": patch
---
A swimlane with more than three steps now draws: its full canvas widens to fit its steps instead of refusing, and on a narrow screen the chat shows the summary and Open diagram. `brain diagram check` now builds axis-type geometry the way the renderer does, so a spec it calls valid no longer falls back to "Renderer failed. Showing source code."
