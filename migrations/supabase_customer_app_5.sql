-- Customer app part 4B (Oct 2026): end-to-end encrypted member chats.
-- Every phone / browser makes its own key pair. The private key never leaves the device. The server only keeps public keys
-- and encrypted messages – nobody else (not the business, not the platform) can read member chats.
CREATE TABLE IF NOT EXISTS ca_device_key (
  account_id           BIGINT NOT NULL,
  device_id            TEXT NOT NULL,
  public_key           TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at           TIMESTAMPTZ NULL,
  PRIMARY KEY (account_id, device_id)
);

-- the encrypted message: content encrypted once, its key wrapped for each device of both people
ALTER TABLE ca_dm_message ADD COLUMN IF NOT EXISTS cipher JSONB NULL;
