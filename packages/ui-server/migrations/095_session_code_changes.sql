-- Code changes are a next-admission preference, independent of the profile.
ALTER TABLE session_worker_profiles ADD COLUMN code_changes INTEGER NOT NULL DEFAULT 0 CHECK (code_changes IN (0,1));
ALTER TABLE draft_worker_profiles ADD COLUMN code_changes INTEGER NOT NULL DEFAULT 0 CHECK (code_changes IN (0,1));
