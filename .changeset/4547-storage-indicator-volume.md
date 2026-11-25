---
"@schlessera/brain-ui-react": patch
---

The app-wide storage indicator now names the affected volume, as the Storage pane names it (#4547): "Brain disk low", "App data disk very low". With several volumes it names the worst one. When the volume could not be identified it reads "Storage warning · very low" instead of a guessed name. Out-of-date and unknown evidence keep their qualifier ("· out of date", "· evidence unknown"), and the control's accessible name carries the same words. To name the volume, the indicator also reads the current storage inventory when there is pressure to report; it never starts a scan.
