-- Reproducible seed: 61 users, ~100k inodes, random-attachment trees (realistic depth spread)
SET search_path = vfs, public;
SELECT setseed(0.42);

CREATE OR REPLACE FUNCTION mk(p_parent uuid, p_name text, p_type "char", p_uid int, p_gid int,
                              p_mode int, p_size bigint, p_mtime timestamptz, p_ino uuid DEFAULT uuidv7())
RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO inodes (ino, type, mode, uid, gid, size, nlink, symlink_target, modified_at, changed_at)
  VALUES (p_ino, p_type, p_mode, p_uid, p_gid, p_size, 1,
          CASE WHEN p_type = 'l' THEN '/tmp' END, p_mtime, p_mtime);
  IF p_parent IS NOT NULL THEN
    INSERT INTO dentries (parent_ino, name, ino, d_type, owner_uid)
    VALUES (p_parent, p_name, p_ino, p_type, p_uid);
  END IF;
  RETURN p_ino;
END $$;

INSERT INTO groups VALUES (0, 'root'), (100, 'users'), (10, 'wheel');
INSERT INTO users (uid, username, password_hash, primary_gid, quota_bytes, quota_inodes)
VALUES (0, 'root', 'x', 0, 9223372036854775807, 9223372036854775807);
INSERT INTO users (uid, username, password_hash, primary_gid, quota_bytes, quota_inodes)
SELECT 1000 + g, 'user' || g, 'x', 100, 5368709120, 50000 FROM generate_series(0, 59) g;
UPDATE users SET username = 'bench' WHERE uid = 1000;
INSERT INTO user_groups SELECT uid, 100 FROM users WHERE uid >= 1000;

DO $$
DECLARE
  root uuid := '00000000-0000-7000-8000-000000000001';
  home uuid; u record; dirs uuid[]; h uuid; p uuid; nid uuid; i int; t "char"; n int;
  d uuid; big uuid; proj uuid; pdirs uuid[];
BEGIN
  PERFORM mk(NULL, NULL, 'd', 0, 0, 493, 0, now(), root);                       -- / 0755
  home := mk(root, 'home', 'd', 0, 0, 493, 0, now());
  PERFORM mk(root, 'bin', 'd', 0, 0, 493, 0, now());
  PERFORM mk(root, 'system', 'd', 0, 0, 493, 0, now());
  PERFORM mk(root, 'tmp', 'd', 0, 0, 1023, 0, now());                           -- 1777
  PERFORM mk(root, 'root', 'd', 0, 0, 448, 0, now());                           -- 0700
  FOR u IN SELECT uid, username FROM users WHERE uid >= 1000 ORDER BY uid LOOP
    h := mk(home, u.username, 'd', u.uid, 100, 448, 0, now());
    dirs := ARRAY[h];
    n := CASE WHEN u.uid = 1000 THEN 150 ELSE 1600 + (random() * 100)::int END;
    FOR i IN 1..n LOOP
      -- prefer recently created directories -> deeper trees, like real projects
      p := dirs[greatest(1, cardinality(dirs) - floor(random() * random() * cardinality(dirs))::int)];
      t := CASE WHEN random() < 0.18 THEN 'd' ELSE 'f' END;
      nid := mk(p, (ARRAY['report','notes','draft','main','index','readme','todo','img','data','test'])[1 + floor(random()*10)::int]
                   || '_' || i || CASE WHEN t = 'f' THEN (ARRAY['.md','.txt','.ts','.pdf','.png'])[1 + floor(random()*5)::int] ELSE '' END,
                t, u.uid, 100, CASE WHEN t = 'd' THEN 493 ELSE 420 END,
                CASE WHEN t = 'f' THEN (random() * 200000)::bigint ELSE 0 END,
                now() - random() * interval '365 days');
      IF t = 'd' THEN dirs := dirs || nid; END IF;
    END LOOP;
    IF u.uid = 1000 THEN
      -- Q1 fixture: /home/bench/a1/a2/a3/a4/a5/a6/target.txt (depth 9 incl. file; depth 8 dir)
      d := h;
      FOR i IN 1..6 LOOP d := mk(d, 'a' || i, 'd', u.uid, 100, 493, 0, now()); END LOOP;
      PERFORM mk(d, 'target.txt', 'f', u.uid, 100, 420, 1234, now());
      -- Q2 fixture: a directory with 500 entries
      big := mk(h, 'big', 'd', u.uid, 100, 493, 0, now());
      FOR i IN 1..500 LOOP
        PERFORM mk(big, 'file_' || lpad((501 - i)::text, 4, '0') || '.txt', 'f', u.uid, 100, 420, 1000 + i, now() - i * interval '1 hour');
      END LOOP;
      -- Q5 / fault-injection fixture: a 1,000-node subtree /home/bench/proj
      proj := mk(h, 'proj', 'd', u.uid, 100, 493, 0, now());
      pdirs := ARRAY[proj];
      FOR i IN 1..999 LOOP
        p := pdirs[greatest(1, cardinality(pdirs) - floor(random() * random() * cardinality(pdirs))::int)];
        t := CASE WHEN random() < 0.15 THEN 'd' ELSE 'f' END;
        nid := mk(p, 'n' || i, t, u.uid, 100, CASE WHEN t = 'd' THEN 493 ELSE 420 END,
                  CASE WHEN t = 'f' THEN (random() * 50000)::bigint ELSE 0 END, now() - random() * interval '30 days');
        IF t = 'd' THEN pdirs := pdirs || nid; END IF;
      END LOOP;
    END IF;
  END LOOP;
END $$;

-- quota accounting consistent with the tree
UPDATE users u SET used_bytes = s.b, used_inodes = s.n
FROM (SELECT uid, sum(size) b, count(*) n FROM inodes GROUP BY uid) s
WHERE s.uid = u.uid AND u.uid <> 0;

VACUUM (ANALYZE) inodes, dentries, users;
SELECT (SELECT count(*) FROM inodes) AS inodes, (SELECT count(*) FROM users) AS users;
