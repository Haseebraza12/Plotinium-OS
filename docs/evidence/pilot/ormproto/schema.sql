-- migrate:up
CREATE TABLE users (
  uid          integer PRIMARY KEY,
  username     text NOT NULL UNIQUE,
  quota_bytes  bigint NOT NULL CHECK (quota_bytes >= 0),
  used_bytes   bigint NOT NULL DEFAULT 0 CHECK (used_bytes >= 0 AND used_bytes <= quota_bytes)
);
CREATE TABLE inodes (
  ino          bigint PRIMARY KEY,
  type         text NOT NULL CHECK (type IN ('file','dir','symlink')),
  mode         smallint NOT NULL CHECK (mode BETWEEN 0 AND 1023),
  uid          integer NOT NULL REFERENCES users,
  size         bigint NOT NULL DEFAULT 0 CHECK (size >= 0),
  version      integer NOT NULL DEFAULT 0,
  modified_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE dentries (
  parent_ino   bigint NOT NULL REFERENCES inodes ON DELETE RESTRICT,
  name         text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 255 AND name NOT IN ('.','..') AND strpos(name,'/') = 0),
  ino          bigint NOT NULL REFERENCES inodes ON DELETE RESTRICT,
  PRIMARY KEY (parent_ino, name)
);
CREATE INDEX dentries_ino_idx ON dentries (ino);
-- migrate:down
DROP TABLE dentries; DROP TABLE inodes; DROP TABLE users;
