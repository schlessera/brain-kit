---
"@schlessera/brain-ui-sdk": patch
---

Name the cause when the agent worker host probe fails because the kernel refuses the worker a fresh `/proc`, as it does under Docker's default masked paths. The refusal now says so and names the Docker remedy (`--security-opt systempaths=unconfined`) instead of the generic list of launcher requirements. The launcher's boundary is unchanged.
