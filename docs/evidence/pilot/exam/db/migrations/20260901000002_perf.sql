-- migrate:up
CREATE INDEX t1_lower_name ON t1 (lower(name) text_pattern_ops);
-- migrate:down
DROP INDEX t1_lower_name;
