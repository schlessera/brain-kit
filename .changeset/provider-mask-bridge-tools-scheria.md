---
"@schlessera/brain-ui-server": minor
---

Host bridge tools now refuse provider-masked folders (#2690). While a provider rule masks a folder for a hosted interactive or voice turn, `brain_read_base`, the application tools, share completion, image masks, `inbox_add` and policy proposals refuse any path at or below that folder with the named `provider_masked` refusal, before reading or writing anything, and record one `provider_mask_refusal` governance event per refused call.
