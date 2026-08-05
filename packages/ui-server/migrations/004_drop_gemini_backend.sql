-- Phase-5 hardening: the native Gemini backend was removed. Reconcile sessions
-- that were pinned to it so they resume cleanly on the default (Claude) backend
-- instead of dangling on a backend id that no longer resolves.
--
-- Rollback note: this rewrites data. Redeploying a Gemini-aware image does NOT
-- restore these ids; a rollback that needs them must reinstate them separately.

-- Clear the profile pin for any session that ran on the removed backend — those
-- profile ids do not exist under the default backend.
UPDATE sessions SET provider_id = NULL WHERE backend_id = 'gemini';

-- Point those sessions at the default backend (getBackendForSession resolves a
-- NULL/unknown backend_id to the default).
UPDATE sessions SET backend_id = NULL WHERE backend_id = 'gemini';

-- Migrate the pre-extraction Claude profile id to its renamed, byte-identical
-- successor so those sessions keep their pin instead of silently dropping to the
-- default model.
UPDATE sessions SET provider_id = 'claude-sonnet-4-6'
WHERE provider_id = 'anthropic-sonnet';
