-- Pill labels (#1004): the few-word label the host's label model wrote for a
-- session's latest request, and a hash of the text it was written from, so a
-- turn that repeats the same request, a reload and a restart all reuse it
-- instead of asking again. Null until a label exists; the pill then prints
-- the session title.
ALTER TABLE sessions ADD COLUMN label TEXT;
ALTER TABLE sessions ADD COLUMN label_source TEXT;
