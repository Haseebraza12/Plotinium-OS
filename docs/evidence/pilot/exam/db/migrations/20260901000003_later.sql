-- migrate:up
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE t2 (id bigint PRIMARY KEY, e vector(3));
-- migrate:down
DROP TABLE t2;
