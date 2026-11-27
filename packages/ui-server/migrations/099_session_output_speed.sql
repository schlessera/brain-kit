-- A session's output speed (#4310), chosen when the session starts and fixed
-- for its life. NULL is a session that predates the choice: it keeps the
-- runtime's own default and is never priced or admitted as fast.
ALTER TABLE sessions ADD COLUMN output_speed TEXT CHECK (output_speed IS NULL OR output_speed IN ('standard', 'fast'));
