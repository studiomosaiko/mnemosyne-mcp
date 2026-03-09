CREATE TABLE purge_tombstones (
  target_id     TEXT PRIMARY KEY,
  target_type   TEXT NOT NULL,
  purged_at     TEXT NOT NULL,
  reason_hmac   TEXT NOT NULL
);
