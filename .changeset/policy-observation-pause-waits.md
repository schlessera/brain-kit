---
"@schlessera/brain-ui-server": patch
---
An approved policy change no longer fails when the turn reaches a scope cap during the check that runs just before the policy is written. Before, the request was refused with "This request no longer has current interactive authority. Nothing was written." Now nothing is written at that point and the turn's Continue or Stop choice stays available. After Continue, the host waits up to the same bound as other held changes, runs every check again (authority, validation, the policy's location and its current contents) and writes the policy once. Stop, cancellation, lost authority or the end of the wait still write nothing and record no policy update.
