-- Plotinium migration 4: the system groups, the root account and the well-known system tree.
-- Spec: specs/04-vfs/virtual-file-system.md §3.3.1-§3.3.2 (VFS-02, C5, PVFS-02);
--       specs/09-database/database.md §3.5 rules 1-4 (DBD-02, DBD-17).
-- Kind: expand.
--
-- Why a migration and not only the demo seed: every database built from these migrations (the
-- examiner stack, CI, the bench database plotinium_bench) needs '/' and the system directories,
-- and the integrity probes treat the well-known ROOT as the single inode without a name.
-- The ids are the fixed version-7 UUIDs with a zero timestamp from the VFS spec table; they are
-- also exported by protocol/src/wellknown.ts (C5), which client mkfs uses. Keep both in step.
--
-- Owners and modes follow spec §9.3: '/', '/bin', '/system' and its children, '/home', '/mnt',
-- '/usr' and below 0755; '/root' and '/lost+found' 0700; '/tmp' 1777; all root:root.
-- Directory nlink = 2 + number of child directories (DBD-17). '/home' starts at 2; creating
-- /home/<user> (server only, C5) adds 1.
-- The root account is created LOCKED (password_hash '!', never a valid PHC string): the
-- first-start seed sets a generated password and prints it once (C10, SRV-20). Root cannot log in
-- at the greeter in any case; it is reached through su.

-- migrate:up
INSERT INTO groups (gid, name) VALUES
  (0,     'root'),
  (100,   'users'),
  (60000, 'guests'),
  (65534, 'nogroup');

INSERT INTO users (uid, username, account_kind, password_hash, primary_gid, quota_bytes, quota_inodes)
VALUES (0, 'root', 'root', '!', 0, 0, 0);      -- root is quota-exempt (users_quota_*_ok)

INSERT INTO inodes (ino, type, mode, uid, gid, size, nlink, version) VALUES
  ('00000000-0000-7000-8000-000000000001', 'd',  493, 0, 0, 0, 10, 1),   -- /                 0755
  ('00000000-0000-7000-8000-000000000002', 'd',  493, 0, 0, 0,  2, 1),   -- /bin              0755
  ('00000000-0000-7000-8000-000000000003', 'd',  493, 0, 0, 0,  5, 1),   -- /system           0755
  ('00000000-0000-7000-8000-000000000004', 'd',  493, 0, 0, 0,  2, 1),   -- /system/services  0755
  ('00000000-0000-7000-8000-000000000005', 'd',  493, 0, 0, 0,  2, 1),   -- /system/log       0755
  ('00000000-0000-7000-8000-000000000006', 'd',  493, 0, 0, 0,  2, 1),   -- /system/branding  0755
  ('00000000-0000-7000-8000-000000000007', 'd',  448, 0, 0, 0,  2, 1),   -- /root             0700
  ('00000000-0000-7000-8000-000000000008', 'd',  493, 0, 0, 0,  2, 1),   -- /home             0755
  ('00000000-0000-7000-8000-000000000009', 'd', 1023, 0, 0, 0,  2, 1),   -- /tmp              1777
  ('00000000-0000-7000-8000-00000000000a', 'd',  493, 0, 0, 0,  2, 1),   -- /mnt              0755
  ('00000000-0000-7000-8000-00000000000b', 'd',  493, 0, 0, 0,  3, 1),   -- /usr              0755
  ('00000000-0000-7000-8000-00000000000c', 'd',  493, 0, 0, 0,  3, 1),   -- /usr/share        0755
  ('00000000-0000-7000-8000-00000000000d', 'd',  493, 0, 0, 0,  2, 1),   -- /usr/share/man    0755
  ('00000000-0000-7000-8000-00000000000e', 'd',  448, 0, 0, 0,  2, 1);   -- /lost+found       0700

INSERT INTO dentries (parent_ino, name, ino, d_type, owner_uid) VALUES
  ('00000000-0000-7000-8000-000000000001', 'bin',        '00000000-0000-7000-8000-000000000002', 'd', 0),
  ('00000000-0000-7000-8000-000000000001', 'system',     '00000000-0000-7000-8000-000000000003', 'd', 0),
  ('00000000-0000-7000-8000-000000000003', 'services',   '00000000-0000-7000-8000-000000000004', 'd', 0),
  ('00000000-0000-7000-8000-000000000003', 'log',        '00000000-0000-7000-8000-000000000005', 'd', 0),
  ('00000000-0000-7000-8000-000000000003', 'branding',   '00000000-0000-7000-8000-000000000006', 'd', 0),
  ('00000000-0000-7000-8000-000000000001', 'root',       '00000000-0000-7000-8000-000000000007', 'd', 0),
  ('00000000-0000-7000-8000-000000000001', 'home',       '00000000-0000-7000-8000-000000000008', 'd', 0),
  ('00000000-0000-7000-8000-000000000001', 'tmp',        '00000000-0000-7000-8000-000000000009', 'd', 0),
  ('00000000-0000-7000-8000-000000000001', 'mnt',        '00000000-0000-7000-8000-00000000000a', 'd', 0),
  ('00000000-0000-7000-8000-000000000001', 'usr',        '00000000-0000-7000-8000-00000000000b', 'd', 0),
  ('00000000-0000-7000-8000-00000000000b', 'share',      '00000000-0000-7000-8000-00000000000c', 'd', 0),
  ('00000000-0000-7000-8000-00000000000c', 'man',        '00000000-0000-7000-8000-00000000000d', 'd', 0),
  ('00000000-0000-7000-8000-000000000001', 'lost+found', '00000000-0000-7000-8000-00000000000e', 'd', 0);

-- Quota mirror for root (probe P5 compares used_* with the owned inodes; root is exempt from the cap).
UPDATE users SET used_inodes = (SELECT count(*) FROM inodes WHERE uid = 0) WHERE uid = 0;

-- migrate:down
DELETE FROM dentries
 WHERE ino IN ('00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000003',
               '00000000-0000-7000-8000-000000000004', '00000000-0000-7000-8000-000000000005',
               '00000000-0000-7000-8000-000000000006', '00000000-0000-7000-8000-000000000007',
               '00000000-0000-7000-8000-000000000008', '00000000-0000-7000-8000-000000000009',
               '00000000-0000-7000-8000-00000000000a', '00000000-0000-7000-8000-00000000000b',
               '00000000-0000-7000-8000-00000000000c', '00000000-0000-7000-8000-00000000000d',
               '00000000-0000-7000-8000-00000000000e');
DELETE FROM inodes
 WHERE ino IN ('00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002',
               '00000000-0000-7000-8000-000000000003', '00000000-0000-7000-8000-000000000004',
               '00000000-0000-7000-8000-000000000005', '00000000-0000-7000-8000-000000000006',
               '00000000-0000-7000-8000-000000000007', '00000000-0000-7000-8000-000000000008',
               '00000000-0000-7000-8000-000000000009', '00000000-0000-7000-8000-00000000000a',
               '00000000-0000-7000-8000-00000000000b', '00000000-0000-7000-8000-00000000000c',
               '00000000-0000-7000-8000-00000000000d', '00000000-0000-7000-8000-00000000000e');
DELETE FROM users WHERE uid = 0;
DELETE FROM groups WHERE gid IN (0, 100, 60000, 65534);
