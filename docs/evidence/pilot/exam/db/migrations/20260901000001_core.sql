-- migrate:up
CREATE TABLE t1 (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL);
-- migrate:down
DROP TABLE t1;
