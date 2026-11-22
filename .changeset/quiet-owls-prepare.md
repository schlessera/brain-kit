---
"@schlessera/brain-ui-server": patch
---

Prepare missing fixed Git mask targets immediately before operation checkpoints, including hosted sync, so separate-UID workers can use repositories whose metadata is not group-writable. A target preparation failure refuses that operation while capability qualification and host boot remain available.
