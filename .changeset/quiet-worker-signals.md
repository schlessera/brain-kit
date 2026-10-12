---
"@schlessera/brain-ui-sdk": patch
---

Reset catchable signal dispositions before launching agent workers, so shell pipelines handle SIGPIPE quietly and oversized file writes terminate with SIGXFSZ. Worker hosts require GNU coreutils env with --default-signal.
