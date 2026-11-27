-- A session's previous root span and the runs with open spans read through
-- partial indexes (#4801). Root rows only, so tool spans pay no extra index
-- write. A root whose session id is only in its attributes keeps its own
-- index, so the lookup never walks the table; a root whose attributes are
-- not JSON is left out rather than failing the build. A later rebuild of
-- activity_spans must recreate all three.
CREATE INDEX idx_activity_spans_root_session ON activity_spans(session_id) WHERE parent_span_id IS NULL AND session_id IS NOT NULL;
CREATE INDEX idx_activity_spans_root_session_attr ON activity_spans(json_extract(attrs, '$."session.id"')) WHERE parent_span_id IS NULL AND session_id IS NULL AND json_valid(attrs);
CREATE INDEX idx_activity_spans_unfinished ON activity_spans(run_id) WHERE outcome IS NULL;
