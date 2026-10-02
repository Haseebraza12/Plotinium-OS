-- Qb: blob de-duplication lookup (database.md §4.11.6; spec §11.4 hash index). The benchmark
-- reports the lookup through blobs_sha256_hash and through blobs_sha256_key (open question 3).
-- $1 = sha256 (32 bytes)
PREPARE qb (bytea) AS
SELECT blob_id, refcount FROM blobs WHERE sha256 = $1;
