---
"@schlessera/brain-ui-sdk": minor
---

**Reference pool growth status (#3515).** `brain-native-store pool growth <config>` and the native manager client's `poolGrowth()` report residual growth on the host-only reference pool from the same simple-quota owner charges as admission. They report each worktree's and each changed refresh's charge against its chain's cold acquisition, and the sources retained per published repository and revision across views. A flag fires strictly above the ruled thresholds: 25 % for a worktree, 0.75× for a refresh, and more than two retained sources. Each flag carries the measured bytes and its threshold.

The status is read-only, reports no forecast savings or freed capacity, and reads missing accounting as `unavailable`, never zero. Sealing now records each root's charge, so the basis survives release. Background deduplication is rejected, as recorded in the pool decision.
