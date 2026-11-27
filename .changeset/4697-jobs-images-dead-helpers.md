---
"@schlessera/brain-module-jobs": patch
"@schlessera/brain-module-images": patch
---

Internal: removes code only tests used (#4697). The jobs module drops the unexported-from-root `SOURCE_STATUSES` list and `BaseAdapter`'s two forwarding methods (the SimplyHired and We Work Remotely adapters call `stripHtml` and `parseRssItems` from `@schlessera/brain-scrape` directly); the images module drops `sizeToNearestGeminiAspect`, which no report called. No entry-point export, CLI output or stored field changes.
