---
"@schlessera/brain-ui-server": patch
---

Prepare missing fixed Git mask targets immediately before operation checkpoints, including hosted sync, so separate-UID workers can use repositories whose metadata is not group-writable. A target preparation failure refuses that operation while capability qualification remains available. Host boot also remains available unless `versionRequirements.brainCli` is set: the startup version probe is such an operation, so a refused probe leaves the CLI version unknown and stops boot.
