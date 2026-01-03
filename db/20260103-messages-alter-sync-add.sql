-- Add edited_timestamp column to messages table (if not exists)
ALTER TABLE messages 
ADD COLUMN IF NOT EXISTS edited_timestamp TIMESTAMPTZ;

-- Create sync_log table to track daily syncs
CREATE TABLE IF NOT EXISTS sync_log (
  sync_date DATE PRIMARY KEY,
  completed_at TIMESTAMPTZ NOT NULL,
  total_messages INTEGER NOT NULL DEFAULT 0,
  total_replies INTEGER NOT NULL DEFAULT 0,
  channels_processed INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for querying recent syncs
CREATE INDEX IF NOT EXISTS idx_sync_log_completed_at ON sync_log(completed_at DESC);

-- Optional: Add comments for documentation
COMMENT ON TABLE sync_log IS 'Tracks daily sync operations to determine full vs incremental sync strategy';
COMMENT ON COLUMN sync_log.sync_date IS 'The date (YYYY-MM-DD) of the sync operation';
COMMENT ON COLUMN sync_log.completed_at IS 'Timestamp when the sync completed';
COMMENT ON COLUMN sync_log.total_messages IS 'Number of new messages synced';
COMMENT ON COLUMN sync_log.total_replies IS 'Number of thread replies synced';
COMMENT ON COLUMN sync_log.channels_processed IS 'Number of channels processed in this sync';