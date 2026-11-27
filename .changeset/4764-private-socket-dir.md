---
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-ui-server": patch
---

The private relay socket directory is created and verified by one module (#4764). The inference relay, the provider relay and the module GitHub relay now do what the egress proxy did: under a separate worker identity they set the directory's and the socket's owner and group to the server's explicitly instead of relying on what `mkdtemp` produced, and they remove the directory when setting the socket's mode or owner fails (the inference and provider relays left it behind before). The launcher's checks before it mounts a relay directory refuse exactly the layouts they refused before, with the same errors; a provider-relay socket beside the egress proxy that does not conform still withholds the provider relay instead of refusing the launch.
